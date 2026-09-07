import type {
  AgentContext,
  MemoryMutationProposal,
  RetrievedMemory,
  SourceExcerpt,
} from '@gerald/contracts';
import { redactSecrets } from '@gerald/contracts';
import { generateId } from '@gerald/security';

export interface MemoryRecord extends RetrievedMemory {
  userId: string;
  deletedAt?: Date;
  supersededBy?: string;
}

export interface MemoryStore {
  propose(userId: string, proposal: Omit<MemoryMutationProposal, 'id'>): MemoryRecord | null;
  search(userId: string, query: string, limit: number): RetrievedMemory[];
  forget(userId: string, memoryId: string): boolean;
  all(userId: string): readonly MemoryRecord[];
}

const secretLike =
  /(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|pin|secret|private key|bearer\s+)/i;

export class InMemoryMemoryStore implements MemoryStore {
  private readonly records: MemoryRecord[] = [];

  propose(userId: string, proposal: Omit<MemoryMutationProposal, 'id'>): MemoryRecord | null {
    const safeText = String(redactSecrets(proposal.text));
    if (
      proposal.sensitivity === 'secret_like' ||
      secretLike.test(safeText) ||
      safeText.includes('[REDACTED')
    )
      return null;
    const record: MemoryRecord = {
      id: generateId(),
      userId,
      kind: proposal.kind,
      text: safeText,
      score: 1,
      authoritative: false,
      provenance: {
        sourceId: proposal.provenance.sourceId,
        sourceType: proposal.provenance.sourceType,
        capturedAt: new Date(),
      },
    };
    if (proposal.supersedesId) {
      const previous = this.records.find(
        (item) => item.id === proposal.supersedesId && item.userId === userId,
      );
      if (previous) previous.supersededBy = record.id;
    }
    this.records.push(record);
    return record;
  }

  search(userId: string, query: string, limit: number): RetrievedMemory[] {
    const terms = tokenize(query);
    return this.records
      .filter((item) => item.userId === userId && !item.deletedAt && !item.supersededBy)
      .map((item) => ({ ...item, score: scoreTerms(item.text, terms) }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          Number(right.authoritative) - Number(left.authoritative) || right.score - left.score,
      )
      .slice(0, limit);
  }

  forget(userId: string, memoryId: string): boolean {
    const record = this.records.find(
      (item) => item.userId === userId && item.id === memoryId && !item.deletedAt,
    );
    if (!record) return false;
    record.deletedAt = new Date();
    record.text = '[DELETED]';
    return true;
  }

  all(userId: string): readonly MemoryRecord[] {
    return this.records.filter((item) => item.userId === userId && !item.deletedAt);
  }
}

export interface RetrievalInputs {
  query: string;
  userId: string;
  sessionTurns: readonly string[];
  taskText: readonly string[];
  entityAliases: readonly string[];
  liveSources?: readonly SourceExcerpt[];
}

export interface RetrievalBackend {
  deterministic(input: RetrievalInputs): RetrievedMemory[];
  lexical(input: RetrievalInputs): RetrievedMemory[];
  vector(input: RetrievalInputs): RetrievedMemory[];
  archival(input: RetrievalInputs): RetrievedMemory[];
}

export class StagedRetriever {
  constructor(private readonly backend: RetrievalBackend) {}

  retrieve(input: RetrievalInputs): { memories: RetrievedMemory[]; sources: SourceExcerpt[] } {
    const deterministic = this.backend.deterministic(input);
    const lexical = this.backend.lexical(input);
    const vector = this.backend.vector(input);
    const merged = reciprocalRankFusion([deterministic, lexical, vector], 8);
    const memories =
      merged.length >= 3 ? merged : reciprocalRankFusion([merged, this.backend.archival(input)], 8);
    const sources = [...(input.liveSources ?? [])].sort(
      (left, right) => Number(right.authoritative) - Number(left.authoritative),
    );
    return { memories, sources: sources.slice(0, 6) };
  }
}

export function assembleContext(input: {
  identity: AgentContext['identity'];
  channel: AgentContext['channel'];
  authentication: AgentContext['authentication'];
  instructions: readonly string[];
  profile: readonly string[];
  session: readonly string[];
  task: readonly string[];
  retrieval: { memories: readonly RetrievedMemory[]; sources: readonly SourceExcerpt[] };
  liveToolResults: readonly string[];
  maxTokens: number;
}): AgentContext {
  const context: AgentContext = {
    instructions: input.instructions,
    identity: input.identity,
    channel: input.channel,
    authentication: input.authentication,
    compactProfile: input.profile.slice(0, 1),
    activeSession: input.session.slice(-10),
    task: input.task.slice(0, 1),
    retrievedMemories: input.retrieval.memories.slice(0, 8),
    sourceExcerpts: input.retrieval.sources.slice(0, 6),
    liveToolResults: input.liveToolResults,
    estimatedTokens: 0,
  };
  const serialized = JSON.stringify(context);
  const estimatedTokens = Math.ceil(serialized.length / 4);
  if (estimatedTokens <= input.maxTokens) return { ...context, estimatedTokens };
  return {
    ...context,
    activeSession: context.activeSession.slice(-4),
    retrievedMemories: context.retrievedMemories.slice(0, 4),
    sourceExcerpts: context.sourceExcerpts.slice(0, 3),
    estimatedTokens: Math.ceil(JSON.stringify(context).length / 4),
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2);
}

function scoreTerms(text: string, terms: readonly string[]): number {
  const haystack = text.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function reciprocalRankFusion(
  lists: readonly RetrievedMemory[][],
  limit: number,
): RetrievedMemory[] {
  const scores = new Map<string, { item: RetrievedMemory; score: number }>();
  lists.forEach((list) =>
    list.forEach((item, index) => {
      const current = scores.get(item.id) ?? { item, score: 0 };
      current.score += 1 / (60 + index + 1);
      scores.set(item.id, current);
    }),
  );
  return [...scores.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score }));
}

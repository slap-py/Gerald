import type {
  AuthenticationState,
  Channel,
  Identity,
  PolicyDecision,
  SecurityMode,
  ToolDescriptor,
} from '@gerald/contracts';

export interface PolicyInput {
  tool: ToolDescriptor;
  channel: Channel;
  authentication: AuthenticationState;
  identity: Identity;
  target?: string;
  explicitUserApproval?: boolean;
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { tool, identity } = input;
  const rules: string[] = [];
  if (!tool.allowedChannels.includes(input.channel)) {
    return {
      effect: 'deny',
      ruleIds: ['channel.tool_not_allowed'],
      reason: `Tool is not available on ${input.channel}`,
    };
  }
  if (!tool.allowedModes.includes(identity.securityMode)) {
    return {
      effect: 'deny',
      ruleIds: ['mode.tool_not_allowed'],
      reason: `Tool is not available in ${identity.securityMode} mode`,
    };
  }
  if (identity.securityMode === 'LOCKED' && tool.sensitivity !== 'public') {
    return {
      effect: 'deny',
      ruleIds: ['mode.locked_private_connectors'],
      reason: 'Private connectors are disabled while locked',
    };
  }
  if (
    identity.securityMode === 'READ_ONLY' &&
    tool.idempotency === 'write' &&
    (tool.name.startsWith('google.') || tool.name.startsWith('email.send'))
  ) {
    return {
      effect: 'deny',
      ruleIds: ['mode.read_only_external_writes'],
      reason: 'External writes are disabled in read-only mode',
    };
  }
  if (authRank(input.authentication) < authRank(tool.requiredAuthentication)) {
    return {
      effect: 'require_authentication',
      ruleIds: ['auth.tool_requirement'],
      reason: `Tool requires ${tool.requiredAuthentication}`,
    };
  }
  if (tool.riskLevel === 'critical' && !input.explicitUserApproval) {
    return {
      effect: 'require_clarification',
      ruleIds: ['risk.explicit_approval'],
      reason: 'This action requires explicit approval',
    };
  }
  if (tool.name.startsWith('email.send')) {
    const target = input.target?.trim().toLowerCase();
    if (!target || !identity.outboundEmailWhitelist.includes(target)) {
      return {
        effect: 'deny',
        ruleIds: ['egress.email_user_whitelist'],
        reason: 'Recipient is not on the outbound email whitelist',
      };
    }
  }
  rules.push('baseline.allow');
  return {
    effect: 'allow',
    ruleIds: rules,
    grantedScope: [tool.name],
    reason: 'All applicable policy checks passed',
  };
}

function authRank(state: AuthenticationState): number {
  return state === 'unauthenticated' ? 0 : state === 'authenticated' ? 1 : 2;
}

export function isPrivateConnectorMode(mode: SecurityMode): boolean {
  return mode !== 'LOCKED';
}

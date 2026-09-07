import type { ReactNode } from 'react';
import Link from 'next/link';

export default function SectionPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <main>
      <Link href="/">← Gerald Console</Link>
      <h1>{title}</h1>
      <p>{description}</p>
      <section>
        {children ?? <small>Data wiring is provided by the authenticated API surface.</small>}
      </section>
    </main>
  );
}

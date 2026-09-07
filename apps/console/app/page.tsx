const sections = [
  'Activity',
  'Tasks',
  'Memory',
  'Connections',
  'Permissions',
  'Security',
  'Approvals',
  'Health',
];

export default function HomePage() {
  return (
    <main>
      <small>Private console · authenticated access required in deployment</small>
      <h1>Gerald</h1>
      <p>A single-user assistant with shared memory, tasks, and controlled integrations.</p>
      <nav>
        {sections.map((section) => (
          <a key={section} href={`/${section.toLowerCase()}`}>
            {section}
          </a>
        ))}
      </nav>
      <section>
        <h2>Onboarding</h2>
        <p>
          Register a passkey, set your preferred name and timezone, then connect Google read-only
          services.
        </p>
      </section>
      <section>
        <h2>Security posture</h2>
        <p>
          System modes: Normal, Read-only, and Locked. Protected writes remain unavailable until a
          later phase adds step-up authentication.
        </p>
      </section>
    </main>
  );
}

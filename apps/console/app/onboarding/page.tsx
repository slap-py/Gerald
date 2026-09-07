import SectionPage from '../components/section-page';

export default function OnboardingPage() {
  return (
    <SectionPage
      title="Onboarding"
      description="Create the private passkey boundary and configure Gerald."
    >
      <p>
        Start a passkey challenge, set your preferred name and timezone, add authorized identities,
        and issue one-time recovery codes.
      </p>
    </SectionPage>
  );
}

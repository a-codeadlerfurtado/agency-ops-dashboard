import type { ReactNode } from "react";
import OnboardingCommandBar from "./onboarding-command-bar";
import OnboardingSectionTabs from "./onboarding-section-tabs";

export default function OnboardingOverviewLayout({ children }: { children: ReactNode }) {
  return <><OnboardingSectionTabs />{children}<OnboardingCommandBar /></>;
}

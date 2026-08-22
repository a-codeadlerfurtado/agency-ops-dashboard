import type { ReactNode } from "react";
import OnboardingCommandBar from "./onboarding-command-bar";

export default function OnboardingOverviewLayout({ children }: { children: ReactNode }) {
  return <>{children}<OnboardingCommandBar /></>;
}

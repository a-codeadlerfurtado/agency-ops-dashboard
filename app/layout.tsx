import type { Viewport } from "next";
import "./globals.css";
import "./mobile.css";
import "./dashboard-enhancements.css";
import "./onboarding-legacy.css";
import IntegrationHealthBar from "./integration-health-bar";
import CampaignsNavBridge from "./campaigns-nav-bridge";
import CampaignNotesBridge from "./campaign-notes-bridge";
import OnboardingNavBridge from "./onboarding-nav-bridge";
import OnboardingAssignmentBridge from "./onboarding-assignment-bridge";
import OnboardingRoleRouter from "./onboarding-role-router";
import OpsQuestionBrand from "./opsquestion-brand";
import OpsQuestionWidget from "./opsquestion-widget";
import WeekendBalanceAlert from "./weekend-balance-alert";
import LearningShortcut from "./learning-shortcut";
import SalesFunnelShortcut from "./sales-funnel-shortcut";
import FridayReportShortcut from "./friday-report-shortcut";
import DashboardEnhancementsGate from "./dashboard-enhancements-gate";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <head>
        {/* A folha de estilo pedia Inter desde sempre, mas a fonte nunca era
            carregada — o app caía no system-ui. Inter Tight entra só nos títulos,
            onde o aperto de tracking faz diferença. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Inter+Tight:wght@600;700;800&display=swap"
        />
      </head>
      <body>
        {children}
        <CampaignsNavBridge />
        <CampaignNotesBridge />
        <OnboardingNavBridge />
        <OnboardingAssignmentBridge />
        <OnboardingRoleRouter />
        <IntegrationHealthBar />
        <DashboardEnhancementsGate />
        <WeekendBalanceAlert />
        <OpsQuestionWidget />
        <OpsQuestionBrand />
        <FridayReportShortcut />
        <SalesFunnelShortcut />
        <LearningShortcut />
      </body>
    </html>
  );
}

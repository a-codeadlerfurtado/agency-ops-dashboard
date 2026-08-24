import type { Viewport } from "next";
import "./globals.css";
import "./mobile.css";
import "./dashboard-enhancements.css";
import "./onboarding-legacy.css";
import "./motion-system.css";
import "./contrast-tune.css";
import IntegrationHealthBar from "./integration-health-bar";
import CampaignsNavBridge from "./campaigns-nav-bridge";
import CampaignNotesBridge from "./campaign-notes-bridge";
import OnboardingNavBridge from "./onboarding-nav-bridge";
import OnboardingAssignmentBridge from "./onboarding-assignment-bridge";
import OnboardingRequiredAlerts from "./onboarding-required-alerts";
import OnboardingRoleRouter from "./onboarding-role-router";
import CommercialNavigationBridge from "./commercial-navigation-bridge";
import CommercialVitorPerformanceBridge from "./commercial-vitor-performance-bridge";
import CommercialNotificationsBridge from "./commercial-notifications-bridge";
import AIHeadRouter from "./ai-head-router";
import OpsQuestionBrand from "./opsquestion-brand";
import OpsQuestionWidget from "./opsquestion-widget";
import WeekendBalanceAlert from "./weekend-balance-alert";
import LeadQualityAlert from "./lead-quality-alert";
import NotificationLeadDetailBridge from "./notification-lead-detail-bridge";
import NotificationLeadClickOverride from "./notification-lead-click-override";
import ClientNotificationsBridge from "./client-notifications-bridge";
import LeonardoMeetingNotificationBridge from "./leonardo-meeting-notification-bridge";
import NotificationsHomeLink from "./notifications-home-link";
import AutomationNavBridge from "./automation-nav-bridge";
import DonnahNavBridge from "./donnah-nav-bridge";
import LearningShortcut from "./learning-shortcut";
import HomeShortcut from "./home-shortcut";
import LogoutShortcut from "./logout-shortcut";
import ProfileMenuDismiss from "./profile-menu-dismiss";
import DashboardEnhancementsGate from "./dashboard-enhancements-gate";
import CockpitCollapseBridge from "./cockpit-collapse-bridge";
import MotionSystem from "./motion-system";
import GreetingAudioBridge from "./greeting-audio-bridge";
import PreGreetingShield from "./pre-greeting-shield";
import DailyGreeting from "./daily-greeting-v3";
import TeamAccessAdmin from "./team-access-admin";
import GabrielTasklogMode from "./gabriel-tasklog-mode";
import GabrielScopeNetwork from "./gabriel-scope-network";
import TeamNowBridge from "./team-now-bridge";

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
        <GabrielScopeNetwork />
        <GreetingAudioBridge />
        <PreGreetingShield />
        {children}
        <MotionSystem />
        <AIHeadRouter />
        <CampaignsNavBridge />
        <CampaignNotesBridge />
        <OnboardingNavBridge />
        <OnboardingAssignmentBridge />
        <OnboardingRequiredAlerts />
        <OnboardingRoleRouter />
        <CommercialNavigationBridge />
        <CommercialVitorPerformanceBridge />
        <CommercialNotificationsBridge />
        <TeamNowBridge />
        <IntegrationHealthBar />
        <DashboardEnhancementsGate />
        <CockpitCollapseBridge />
        <WeekendBalanceAlert />
        <LeadQualityAlert />
        <NotificationLeadDetailBridge />
        <NotificationLeadClickOverride />
        <ClientNotificationsBridge />
        <LeonardoMeetingNotificationBridge />
        <NotificationsHomeLink />
        <AutomationNavBridge />
        <DonnahNavBridge />
        <TeamAccessAdmin />
        <GabrielTasklogMode />
        <DailyGreeting />
        <OpsQuestionWidget />
        <OpsQuestionBrand />
        <LearningShortcut />
        <HomeShortcut />
        <LogoutShortcut />
        <ProfileMenuDismiss />
      </body>
    </html>
  );
}
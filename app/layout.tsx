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
import OnboardingHistoryNotificationBridge from "./onboarding-history-notification-bridge";
import OnboardingHistoryPrecisionBridge from "./onboarding-history-precision-bridge";
import LeonardoScopeNetwork from "./leonardo-scope-network";
import AdlerFinanceNavBridge from "./adler-finance-nav-bridge";
import ClientBalancesNavBridge from "./client-balances-nav-bridge";
import AdlerNotificationAreaFilter from "./adler-notification-area-filter";
import MetaPerformanceProfileBridge from "./meta-performance-profile-bridge";
import AIHeadRouter from "./ai-head-router";
import OpsQuestionBrand from "./opsquestion-brand";
import OpsQuestionWidget from "./opsquestion-widget";
import WeekendBalanceAlert from "./weekend-balance-alert";
import LeadQualityAlert from "./lead-quality-alert";
import ChurnedClientMessageWarning from "./churned-client-message-warning";
import ManagerAttentionRadarWarning from "./manager-attention-radar-warning";
import ManagerAttentionContextBridge from "./manager-attention-context-bridge";
import CompletedWorkItemDetailBridge from "./completed-work-item-detail-bridge";
import NotificationLeadDetailBridge from "./notification-lead-detail-bridge";
import NotificationLeadClickOverride from "./notification-lead-click-override";
import ClientNotificationsBridge from "./client-notifications-bridge";
import LeonardoMeetingNotificationBridge from "./leonardo-meeting-notification-bridge";
import LeonardoActionWarning from "./leonardo-action-warning";
import NotificationsHomeLink from "./notifications-home-link";
import NotificationDetailBridge from "./notification-detail-bridge";
import WorkCenterScopeNetwork from "./work-center-scope-network";
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
import PreclientsKanbanBridge from "./preclients-kanban-bridge";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Inter+Tight:wght@600;700;800&display=swap"
        />
      </head>
      <body>
        <GabrielScopeNetwork />
        <LeonardoScopeNetwork />
        <WorkCenterScopeNetwork />
        <GreetingAudioBridge />
        <PreGreetingShield />
        {children}
        <PreclientsKanbanBridge />
        <MotionSystem />
        <AIHeadRouter />
        <CampaignsNavBridge />
        <CampaignNotesBridge />
        <OnboardingNavBridge />
        <OnboardingAssignmentBridge />
        <OnboardingRequiredAlerts />
        <OnboardingRoleRouter />
        <AdlerFinanceNavBridge />
        <ClientBalancesNavBridge />
        <AdlerNotificationAreaFilter />
        <MetaPerformanceProfileBridge />
        <IntegrationHealthBar />
        <DashboardEnhancementsGate />
        <CockpitCollapseBridge />
        <WeekendBalanceAlert />
        <LeadQualityAlert />
        <ChurnedClientMessageWarning />
        <ManagerAttentionRadarWarning />
        <ManagerAttentionContextBridge />
        <CompletedWorkItemDetailBridge />
        <NotificationLeadDetailBridge />
        <NotificationLeadClickOverride />
        <ClientNotificationsBridge />
        <LeonardoMeetingNotificationBridge />
        <LeonardoActionWarning />
        <NotificationsHomeLink />
        <OnboardingHistoryNotificationBridge />
        <OnboardingHistoryPrecisionBridge />
        <NotificationDetailBridge />
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
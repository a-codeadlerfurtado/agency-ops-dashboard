import type { Viewport } from "next";
import "./globals.css";
import "./mobile.css";
import "./dashboard-enhancements.css";
import "./onboarding-legacy.css";
import "./motion-system.css";
import "./contrast-tune.css";
import "./meta-radar/radar-polish.css";
import "./meta-radar/radar-color-system.css";
import "./meta-radar/radar-v2.css";
import "./meta-consultant.css";
import "./ads-intelligence.css";
import "./ads-intelligence-structure.css";
import "./ads-intelligence-ad-preview.css";
import "./ads-intelligence-ops.css";
import "./meta-weekly-reports.css";
import "./client-access-vault.css";
import "./client-meta-assets.css";
import "./system-update-center.css";
import "./security-center.css";
import "./client-360.css";
import "./sidebar-stability-fix.css";
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
import MetaCreativePreviewResponseBridge from "./meta-creative-preview-response-bridge";
import MetaPerformanceProfileBridge from "./meta-performance-profile-bridge";
import MetaAnalysisNavBridge from "./meta-analysis-nav-bridge";
import MetaRadarNavBridge from "./meta-radar-nav-bridge";
import MetaConsultantInlineBridge from "./meta-consultant-inline-bridge";
import AdsIntelligenceInlineBridge from "./ads-intelligence-inline-bridge";
import AdsIntelligenceStructureBridge from "./ads-intelligence-structure-bridge";
import AdsIntelligenceAdPreviewBridge from "./ads-intelligence-ad-preview-bridge";
import AdsIntelligenceOpsBridge from "./ads-intelligence-ops-bridge";
import MetaWeeklyReportsInlineBridge from "./meta-weekly-reports-inline-bridge";
import WeeklyReportDeliveryCheckboxBridge from "./weekly-report-delivery-checkbox-bridge";
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
import ClientCommercialProfileBridge from "./client-commercial-profile-bridge";
import ClientAccessVaultBridge from "./client-access-vault-bridge";
import AdlerPasswordManagerBridge from "./adler-password-manager-bridge";
import ImobiBoardCentralBridge from "./imobi-board-central-bridge";
import ClientMetaAssetsBridge from "./client-meta-assets-bridge";
import ClientContextUploadBridge from "./client-context-upload-bridge";
import Client360Bridge from "./client-360-bridge";
import CreativeManualEditBridge from "./creative-manual-edit-bridge";
import CreativeIntelligenceBridge from "./creative-intelligence-bridge";
import LeonardoMeetingNotificationBridge from "./leonardo-meeting-notification-bridge";
import LeonardoActionWarning from "./leonardo-action-warning";
import NotificationsHomeLink from "./notifications-home-link";
import NotificationDetailBridge from "./notification-detail-bridge";
import NotificationReadOnClick from "./notification-read-on-click";
import WorkCenterScopeNetwork from "./work-center-scope-network";
import AutomationNavBridge from "./automation-nav-bridge";
import DonnahNavBridge from "./donnah-nav-bridge";
import DiagnosticsNavBridge from "./diagnostics-nav-bridge";
import SidebarInformationArchitecture from "./sidebar-information-architecture-v2";
import NavBrandIcons from "./nav-brand-icons-v3";
import LearningShortcut from "./learning-shortcut";
import HomeShortcut from "./home-shortcut";
import LogoutShortcut from "./logout-shortcut";
import ProfileMenuDismiss from "./profile-menu-dismiss";
import NotificationPanelDismiss from "./notification-panel-dismiss";
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
import SystemUpdateCenter from "./system-update-center";
import SecurityCenter from "./security-center";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <head>
        {/* A aba nao tinha titulo nem icone: o navegador mostrava o icone
            generico e a URL. "Central de Operacoes" e o nome que o proprio
            produto usa no h1. */}
        <title>Central de Operações</title>

        {/* Icone inline como data URI, e nao arquivo, porque o projeto nao tem
            diretorio publico -- todo asset sai do build do vinext. Sao 443
            caracteres, servidos junto do HTML, sem requisicao extra. A CSP do
            worker permite (img-src 'self' data:).

            O traco do simbolo original tem 5% da largura da marca: meio pixel
            a 16px, que e o tamanho real da aba. Aqui vai ~2x mais grosso e
            sobre placa azul da marca. Renderizado em 16/20/32/64/128 sobre
            fundo claro e sobre a barra de abas escura do Chrome: fiel ao
            original vira mancha cinza no claro e some no escuro. */}
        <link
          rel="icon"
          type="image/svg+xml"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230359a6'/><g fill='%23fff'><rect x='8.46' y='5.5' width='15.09' height='1.45'/><rect x='8.46' y='5.5' width='1.56' height='21.00'/><rect x='21.98' y='5.5' width='1.56' height='14.38'/><path d='M12.31 17.49 L23.54 19.07 L23.54 19.88 L12.31 19.88 Z'/><path d='M19.69 24.11 L8.46 25.69 L8.46 26.5 L19.69 26.5 Z'/></g></svg>"
        />

        {/* Icone e modo tela cheia da Tela de Inicio.

            O head so tinha rel="icon" em data URI, que serve a aba e mais
            nada. Sem apple-touch-icon o iOS nao tem de onde tirar o icone e
            usa o fallback dele -- um print da propria pagina -- e sem
            apple-mobile-web-app-capable ele abre dentro do Safari, com a
            barra embaixo. Os dois sintomas vinham daqui.

            O PNG e o BrandMark de shared.tsx (o logo da Leonardo Imobi que o
            cabecalho ja usa), sobre o mesmo gradiente de .logo. Nao e o
            favicon acima: aquele e um redesenho engrossado para sobreviver a
            16px, proporcao errada para 180. Opaco e sem canto arredondado de
            proposito -- o iOS compoe alfa sobre preto e aplica a mascara.

            status-bar-style vai "black", nao "black-translucent": translucido
            joga o conteudo por baixo da barra de status, e o layout nao
            reserva safe-area para isso. */}
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Central Ops" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black" />

        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Inter+Tight:wght@600;700;800&display=swap" />
      </head>
      <body>
        <GabrielScopeNetwork />
        <LeonardoScopeNetwork />
        <WorkCenterScopeNetwork />
        {children}
        <GreetingAudioBridge />
        <PreGreetingShield />
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
        <MetaCreativePreviewResponseBridge />
        <MetaPerformanceProfileBridge />
        <MetaRadarNavBridge />
        <MetaConsultantInlineBridge />
        <AdsIntelligenceInlineBridge />
        <AdsIntelligenceStructureBridge />
        <AdsIntelligenceAdPreviewBridge />
        <AdsIntelligenceOpsBridge />
        <MetaWeeklyReportsInlineBridge />
        <WeeklyReportDeliveryCheckboxBridge />
        <MetaAnalysisNavBridge />
        <IntegrationHealthBar />
        <DashboardEnhancementsGate />
        <Client360Bridge />
        <ClientCommercialProfileBridge />
        <ClientAccessVaultBridge />
        {/* Cofre global e central do CRM: ambos se escondem sozinhos para
            quem nao e o perfil MGMT do Adler. */}
        <AdlerPasswordManagerBridge />
        <ImobiBoardCentralBridge />
        <ClientMetaAssetsBridge />
        <ClientContextUploadBridge />
        <CreativeManualEditBridge />
        <CreativeIntelligenceBridge />
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
        <NotificationReadOnClick />
        <AutomationNavBridge />
        <DonnahNavBridge />
        <DiagnosticsNavBridge />
        <SidebarInformationArchitecture />
        <NavBrandIcons />
        <TeamAccessAdmin />
        <GabrielTasklogMode />
        <DailyGreeting />
        <SystemUpdateCenter />
        <SecurityCenter />
        <OpsQuestionWidget />
        <OpsQuestionBrand />
        <LearningShortcut />
        <HomeShortcut />
        <LogoutShortcut />
        <ProfileMenuDismiss />
        <NotificationPanelDismiss />
      </body>
    </html>
  );
}

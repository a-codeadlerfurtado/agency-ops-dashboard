import "./globals.css";
import IntegrationHealthBar from "./integration-health-bar";
import CampaignsNavBridge from "./campaigns-nav-bridge";
import OnboardingNavBridge from "./onboarding-nav-bridge";
import OnboardingAssignmentBridge from "./onboarding-assignment-bridge";
import OpsQuestionBrand from "./opsquestion-brand";
import OpsQuestionWidget from "./opsquestion-widget";

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
        <OnboardingNavBridge />
        <OnboardingAssignmentBridge />
        <IntegrationHealthBar />
        <OpsQuestionWidget />
        <OpsQuestionBrand />
      </body>
    </html>
  );
}

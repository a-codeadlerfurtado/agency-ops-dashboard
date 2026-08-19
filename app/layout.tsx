import "./globals.css";
import IntegrationHealthBar from "./integration-health-bar";

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>
        {children}
        <IntegrationHealthBar />
      </body>
    </html>
  );
}

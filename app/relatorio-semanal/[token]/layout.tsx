import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Relatório semanal de performance",
  robots: { index: false, follow: false, nocache: true },
};

export default function WeeklyReportLayout({children}:{children:React.ReactNode}){return children;}

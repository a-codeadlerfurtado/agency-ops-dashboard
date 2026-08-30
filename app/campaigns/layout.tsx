import CampaignsSubnav from "./campaigns-subnav";
import CampaignInlineActionsV2 from "./campaign-inline-actions-v2";

export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        .tc-area-subnav{position:sticky;top:0;z-index:80;display:flex;gap:8px;align-items:center;padding:10px 18px;background:rgba(5,12,20,.94);backdrop-filter:blur(14px);border-bottom:1px solid #1a344b;font-family:Inter,system-ui,sans-serif}
        .tc-area-subnav a{color:#91a8bc;text-decoration:none;font-size:12px;font-weight:800;padding:8px 12px;border:1px solid transparent;border-radius:10px;transition:.17s ease}
        .tc-area-subnav a:hover{color:#dff4ff;background:rgba(70,180,255,.08);border-color:#214761}
        .tc-area-subnav a.active{color:#fff;background:linear-gradient(135deg,rgba(242,107,33,.2),rgba(80,190,255,.12));border-color:#b85b28;box-shadow:inset 3px 0 0 #f26b21}
      `}</style>
      <CampaignsSubnav />
      <CampaignInlineActionsV2 />
      {children}
    </>
  );
}

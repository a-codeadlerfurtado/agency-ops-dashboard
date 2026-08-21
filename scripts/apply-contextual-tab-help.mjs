import fs from "node:fs";

function mustReplace(source, needle, replacement, label) {
  if (source.includes(replacement)) return source;
  if (!source.includes(needle)) throw new Error(`Patch point not found: ${label}`);
  return source.replace(needle, replacement);
}

{
  const path = "app/page.tsx";
  let source = fs.readFileSync(path, "utf8");
  source = mustReplace(
    source,
    'import type { HomeData, Row, TeamMember, View } from "./shared";',
    'import type { HomeData, Row, TeamMember, View } from "./shared";\nimport { TabHelp } from "./tab-help";',
    "dashboard import",
  );
  source = mustReplace(
    source,
    '    <main className={`shell ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>',
    '    <main className={`shell ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>\n      <TabHelp view={view} profile={data?.profile || {}} />',
    "dashboard main",
  );
  fs.writeFileSync(path, source);
}

{
  const path = "app/ia/page.tsx";
  let source = fs.readFileSync(path, "utf8");
  source = mustReplace(
    source,
    'import { AI_API_BASE, BrandMark, supabase } from "../shared";',
    'import { AI_API_BASE, BrandMark, supabase } from "../shared";\nimport { TabHelp } from "../tab-help";',
    "ai import",
  );
  source = mustReplace(
    source,
    '    <main className={`ai-shell ${sidebarOpen ? "ai-sidebar-open" : "ai-sidebar-closed"}`}>',
    '    <main className={`ai-shell ${sidebarOpen ? "ai-sidebar-open" : "ai-sidebar-closed"}`}>\n      <TabHelp view="ai" profile={{ person: profile?.person, role: profile?.role, access_level: profile?.accessLevel }} />',
    "ai main",
  );
  fs.writeFileSync(path, source);
}

console.log("Contextual tab help patched successfully.");

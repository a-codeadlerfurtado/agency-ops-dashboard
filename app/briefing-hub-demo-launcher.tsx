"use client";

import BriefingHubDemoLink from "./briefing-hub-demo-link";

export default function BriefingHubDemoLauncher(){
  return <div style={{position:"fixed",right:18,bottom:84,zIndex:9000}}><BriefingHubDemoLink/></div>;
}

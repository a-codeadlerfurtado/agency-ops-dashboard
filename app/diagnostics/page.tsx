"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, formatDate, formatMoney, formatNumber, supabase, text } from "../shared";

type Row = Record<string, any>;
type Tab = "overview" | "accounts" | "questions" | "sla" | "diagnoses" | "experiments";
type Payload = { ok?: boolean; summary?: Row; clients?: Row[]; runs?: Row[]; questions?: Row[]; slas?: Row[]; events?: Row[]; experiments?: Row[]; generated_at?: string };

const API = `${SUPABASE_URL}/functions/v1/agency-ops-diagnostics-api`;
const priorityWeight: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const tabs: Array<[Tab,string]> = [["overview","Visão Geral"],["accounts","Contas"],["questions","Perguntas"],["sla","SLAs"],["diagnoses","Diagnósticos"],["experiments","Experimentos"]];
const pri = (v: unknown) => ({CRITICAL:"Crítica",HIGH:"Alta",MEDIUM:"Média",LOW:"Baixa"} as Row)[String(v||"").toUpperCase()] || text(v||"—");
const slaLabel = (v: unknown) => ({MET:"Cumprido",BREACHED:"Estourado",PENDING:"Em curso",BLOCKED:"Bloqueado",NOT_APPLICABLE:"N/A"} as Row)[String(v||"").toUpperCase()] || text(v||"—");

const CSS = `
.dg{min-height:100vh;background:#091015;color:#edf4f8;padding:28px}.dg-wrap{max-width:1500px;margin:0 auto}.dg-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.dg-head h1{margin:5px 0 4px;font-size:30px}.dg-kicker{font-size:10px;font-weight:900;letter-spacing:.1em;text-transform:uppercase;color:#ff9156}.dg-sub{color:#91a0aa;font-size:12px}.dg-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0}.dg-tabs button,.dg-btn{border:1px solid #33424c;background:#111920;color:#dce6eb;border-radius:9px;padding:8px 11px;cursor:pointer}.dg-tabs button.active,.dg-btn.primary{border-color:#ff7a2f;background:#ff7a2f;color:#fff}.dg-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.dg-card{border:1px solid #293740;background:#0f171c;border-radius:13px;padding:14px}.dg-card small{color:#83939d;font-size:9px;font-weight:800;text-transform:uppercase}.dg-card b{display:block;margin-top:7px;font-size:22px}.dg-section{margin-top:14px;border:1px solid #293740;background:#0d151a;border-radius:14px;overflow:hidden}.dg-title{display:flex;justify-content:space-between;gap:10px;padding:14px;border-bottom:1px solid #24323b}.dg-title h2{margin:0;font-size:15px}.dg-list{display:grid}.dg-row{display:grid;grid-template-columns:minmax(180px,1.2fr) minmax(180px,1fr) repeat(3,minmax(90px,.6fr));gap:10px;padding:12px 14px;border-bottom:1px solid #223039;align-items:center}.dg-row:last-child{border-bottom:0}.dg-row b{font-size:12px}.dg-row span,.dg-row small{font-size:10px;color:#93a2ac}.dg-danger{color:#ff8d8d!important}.dg-warn{color:#ffb278!important}.dg-ok{color:#65d4a7!important}.dg-toolbar{display:flex;gap:8px;padding:12px}.dg-toolbar input,.dg-answer textarea{width:100%;border:1px solid #34434d;background:#091015;color:#eef5f8;border-radius:9px;padding:10px}.dg-question{padding:13px 14px;border-bottom:1px solid #223039}.dg-question p{margin:5px 0;color:#c7d2d8;font-size:12px}.dg-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.dg-error{margin:12px 0;border:1px solid #6e3030;background:#321719;color:#ffb1b1;border-radius:10px;padding:10px}.dg-empty{padding:28px;text-align:center;color:#8e9da7}.dg-answer{padding:12px;border-top:1px solid #31414b}.dg-answer textarea{min-height:90px;resize:vertical}@media(max-width:900px){.dg{padding:16px}.dg-grid{grid-template-columns:1fr 1fr}.dg-row{grid-template-columns:1fr}.dg-head{flex-direction:column}}
`;

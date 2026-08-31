"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Row = Record<string, any>;
type TargetingTab = "audience" | "location" | "placements" | "advanced";

type ObjectItem = { id?: string; key?: string; name?: string; radius?: number; distance_unit?: string; [key: string]: any };

const PLATFORMS = [
  ["facebook", "Facebook"],
  ["instagram", "Instagram"],
  ["messenger", "Messenger"],
  ["audience_network", "Audience Network"],
] as const;

const POSITIONS: Record<string, Array<[string, string]>> = {
  facebook_positions: [
    ["feed", "Feed"], ["story", "Stories"], ["facebook_reels", "Reels"], ["video_feeds", "Feeds de vídeo"],
    ["marketplace", "Marketplace"], ["right_hand_column", "Coluna da direita"], ["search", "Resultados de pesquisa"],
    ["instant_article", "Artigos Instantâneos"], ["profile_feed", "Feed do perfil"], ["facebook_business_explore", "Explorar negócios"],
  ],
  instagram_positions: [
    ["stream", "Feed"], ["story", "Stories"], ["reels", "Reels"], ["explore", "Explorar"], ["explore_home", "Página inicial do Explorar"],
    ["profile_feed", "Feed do perfil"], ["ig_search", "Pesquisa"], ["ig_profile_reels", "Reels do perfil"],
  ],
  messenger_positions: [["messenger_home", "Caixa de entrada"], ["story", "Stories"], ["sponsored_messages", "Mensagens patrocinadas"]],
  audience_network_positions: [["classic", "Nativo, banner e intersticial"], ["instream_video", "Vídeo in-stream"], ["rewarded_video", "Vídeo com recompensa"]],
};

const DETAIL_CATEGORIES = [
  ["interests", "Interesses"], ["behaviors", "Comportamentos"], ["life_events", "Acontecimentos"], ["industries", "Setores"],
  ["work_positions", "Cargos"], ["employers", "Empregadores"], ["education_schools", "Instituições de ensino"],
  ["education_majors", "Áreas de estudo"], ["family_statuses", "Situação familiar"], ["relationship_statuses", "Relacionamento"],
] as const;

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value ?? {}));
const array = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const stringArray = (value: unknown) => array<unknown>(value).map(String).filter(Boolean);
const compact = (value: string) => value.trim();

function setNativeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter) setter.call(textarea, value); else textarea.value = value;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function parseTargeting(raw: string): Row {
  const text = raw.trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function cleanupObject(target: Row, key: string) {
  const value = target[key];
  if (Array.isArray(value) && value.length === 0) delete target[key];
  else if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) delete target[key];
}

function TagEditor({ values, placeholder, onChange }: { values: string[]; placeholder: string; onChange: (next: string[]) => void }) {
  const [input, setInput] = useState("");
  const add = () => {
    const value = compact(input);
    if (!value) return;
    if (!values.includes(value)) onChange([...values, value]);
    setInput("");
  };
  return <div className="aii-tv-tag-editor">
    <div className="aii-tv-chips">{values.map((value) => <span className="aii-tv-chip" key={value}>{value}<button type="button" onClick={() => onChange(values.filter((item) => item !== value))}>×</button></span>)}</div>
    <div className="aii-tv-add"><input value={input} placeholder={placeholder} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /><button type="button" onClick={add}>Adicionar</button></div>
  </div>;
}

function ObjectEditor({ values, idKey = "id", idPlaceholder = "ID", namePlaceholder = "Nome", onChange }: { values: ObjectItem[]; idKey?: "id" | "key"; idPlaceholder?: string; namePlaceholder?: string; onChange: (next: ObjectItem[]) => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const add = () => {
    const key = compact(id);
    if (!key) return;
    if (!values.some((item) => String(item[idKey] || "") === key)) onChange([...values, { [idKey]: key, ...(compact(name) ? { name: compact(name) } : {}) }]);
    setId(""); setName("");
  };
  return <div className="aii-tv-object-editor">
    <div className="aii-tv-chips">{values.map((item, index) => {
      const key = String(item[idKey] || index);
      return <span className="aii-tv-chip object" key={`${key}-${index}`}><b>{item.name || item[idKey] || "Item"}</b>{item.name && item[idKey] ? <small>{item[idKey]}</small> : null}<button type="button" onClick={() => onChange(values.filter((_, i) => i !== index))}>×</button></span>;
    })}</div>
    <div className="aii-tv-add two"><input value={name} placeholder={namePlaceholder} onChange={(e) => setName(e.target.value)} /><input value={id} placeholder={idPlaceholder} onChange={(e) => setId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /><button type="button" onClick={add}>Adicionar</button></div>
  </div>;
}

function CheckGrid({ options, selected, onChange }: { options: Array<readonly [string, string]>; selected: string[]; onChange: (next: string[]) => void }) {
  return <div className="aii-tv-check-grid">{options.map(([value, label]) => <label key={value}><input type="checkbox" checked={selected.includes(value)} onChange={() => onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value])} /><span>{label}</span></label>)}</div>;
}

function DetailGroupEditor({ title, group, onChange, removable, onRemove }: { title: string; group: Row; onChange: (next: Row) => void; removable?: boolean; onRemove?: () => void }) {
  const [category, setCategory] = useState("interests");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const keys = useMemo(() => {
    const present = Object.keys(group).filter((key) => Array.isArray(group[key]));
    const known = DETAIL_CATEGORIES.map(([key]) => key);
    return [...new Set([...present, ...known.filter((key) => present.includes(key))])];
  }, [group]);
  const add = () => {
    const cleanId = compact(id);
    if (!cleanId) return;
    const next = clone(group);
    const items = array<ObjectItem>(next[category]);
    if (!items.some((item) => String(item.id || item.key || "") === cleanId)) items.push({ id: cleanId, ...(compact(name) ? { name: compact(name) } : {}) });
    next[category] = items;
    onChange(next); setId(""); setName("");
  };
  return <div className="aii-tv-detail-group">
    <div className="aii-tv-detail-head"><b>{title}</b>{removable ? <button type="button" onClick={onRemove}>Remover grupo</button> : null}</div>
    {keys.length ? keys.map((key) => {
      const items = array<any>(group[key]);
      if (!items.length) return null;
      const label = DETAIL_CATEGORIES.find(([value]) => value === key)?.[1] || key.replaceAll("_", " ");
      return <div className="aii-tv-detail-line" key={key}><small>{label}</small><div className="aii-tv-chips">{items.map((item, index) => {
        const isObject = item && typeof item === "object";
        const value = isObject ? String(item.name || item.id || item.key || index) : String(item);
        const code = isObject ? String(item.id || item.key || "") : "";
        return <span className="aii-tv-chip object" key={`${value}-${index}`}><b>{value}</b>{code && code !== value ? <small>{code}</small> : null}<button type="button" onClick={() => { const next = clone(group); next[key] = items.filter((_, i) => i !== index); cleanupObject(next, key); onChange(next); }}>×</button></span>;
      })}</div></div>;
    }) : <p className="aii-tv-empty-inline">Nenhum detalhamento configurado.</p>}
    <div className="aii-tv-add detail"><select value={category} onChange={(e) => setCategory(e.target.value)}>{DETAIL_CATEGORIES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><input value={name} placeholder="Nome" onChange={(e) => setName(e.target.value)} /><input value={id} placeholder="ID Meta" onChange={(e) => setId(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /><button type="button" onClick={add}>Adicionar</button></div>
  </div>;
}

export default function AdsIntelligenceTargetingVisualBridge() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null);
  const [targeting, setTargeting] = useState<Row>({});
  const [raw, setRaw] = useState("");
  const [rawError, setRawError] = useState("");
  const [tab, setTab] = useState<TargetingTab>("audience");
  const labelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let mountedTextarea: HTMLTextAreaElement | null = null;
    let mountedLabel: HTMLElement | null = null;
    let mountedHost: HTMLElement | null = null;
    let scheduled = false;

    const detach = () => {
      if (mountedLabel) mountedLabel.style.display = "";
      mountedHost?.remove();
      mountedTextarea = null; mountedLabel = null; mountedHost = null;
      labelRef.current = null;
      setHost(null); setTextarea(null);
    };

    const install = () => {
      scheduled = false;
      const nextTextarea = document.querySelector<HTMLTextAreaElement>(".aii-editor-modal .aii-json-field textarea");
      if (!nextTextarea) { if (mountedTextarea) detach(); return; }
      if (nextTextarea === mountedTextarea && mountedHost?.isConnected) return;
      detach();
      const label = nextTextarea.closest<HTMLElement>(".aii-json-field");
      const section = label?.closest<HTMLElement>(".aii-editor-section");
      if (!label || !section) return;
      const nextHost = document.createElement("div");
      nextHost.className = "aii-targeting-visual-host";
      section.insertBefore(nextHost, label);
      label.style.display = "none";
      mountedTextarea = nextTextarea; mountedLabel = label; mountedHost = nextHost; labelRef.current = label;
      const initial = nextTextarea.value || "";
      setRaw(initial);
      try { setTargeting(parseTargeting(initial)); setRawError(""); } catch { setTargeting({}); setRawError("O targeting atual contém JSON inválido."); }
      setTab("audience");
      setTextarea(nextTextarea); setHost(nextHost);
    };
    const schedule = () => { if (scheduled) return; scheduled = true; requestAnimationFrame(install); };
    install();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); detach(); };
  }, []);

  useEffect(() => {
    if (!textarea) return;
    const sync = () => {
      const nextRaw = textarea.value || "";
      setRaw(nextRaw);
      try { setTargeting(parseTargeting(nextRaw)); setRawError(""); } catch { setRawError("JSON inválido. Corrija antes de salvar."); }
    };
    textarea.addEventListener("input", sync);
    return () => textarea.removeEventListener("input", sync);
  }, [textarea]);

  const commit = useCallback((next: Row) => {
    if (!textarea) return;
    const text = JSON.stringify(next, null, 2);
    setTargeting(next); setRaw(text); setRawError("");
    setNativeTextareaValue(textarea, text);
  }, [textarea]);

  const mutate = useCallback((fn: (next: Row) => void) => {
    const next = clone(targeting);
    fn(next);
    commit(next);
  }, [targeting, commit]);

  const geo = targeting.geo_locations && typeof targeting.geo_locations === "object" ? targeting.geo_locations as Row : {};
  const countries = stringArray(geo.countries);
  const regions = array<ObjectItem>(geo.regions);
  const cities = array<ObjectItem>(geo.cities);
  const zips = array<ObjectItem>(geo.zips);
  const locationTypes = stringArray(geo.location_types);
  const customAudiences = array<ObjectItem>(targeting.custom_audiences);
  const excludedAudiences = array<ObjectItem>(targeting.excluded_custom_audiences);
  const flexibleSpec = array<Row>(targeting.flexible_spec);
  const exclusions = targeting.exclusions && typeof targeting.exclusions === "object" ? targeting.exclusions as Row : {};
  const publishers = stringArray(targeting.publisher_platforms);
  const autoPlacements = !publishers.length && !Object.keys(POSITIONS).some((key) => stringArray(targeting[key]).length);
  const devicePlatforms = stringArray(targeting.device_platforms);
  const allDevices = !devicePlatforms.length;
  const genderValues = array<number>(targeting.genders).map(Number).filter((n) => n === 1 || n === 2);
  const allGenders = genderValues.length === 0 || genderValues.length === 2;
  const unknownTopLevel = Object.keys(targeting).filter((key) => ![
    "geo_locations", "age_min", "age_max", "genders", "locales", "custom_audiences", "excluded_custom_audiences", "flexible_spec", "exclusions",
    "publisher_platforms", "facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions", "device_platforms", "user_os", "user_device", "wireless_carrier",
  ].includes(key));

  if (!host || !textarea) return null;

  return createPortal(<div className="aii-tv-root">
    <div className="aii-tv-topline">
      <div><b>Segmentação visual</b><span>Os campos não mapeados continuam preservados no objeto enviado à Meta.</span></div>
      <div className="aii-tv-summary"><span>{countries.length + regions.length + cities.length + zips.length} locais</span><span>{customAudiences.length} públicos</span><span>{autoPlacements ? "Advantage+ placements" : `${publishers.length} plataformas`}</span></div>
    </div>
    <nav className="aii-tv-tabs">
      <button type="button" className={tab === "audience" ? "active" : ""} onClick={() => setTab("audience")}>Público</button>
      <button type="button" className={tab === "location" ? "active" : ""} onClick={() => setTab("location")}>Localização</button>
      <button type="button" className={tab === "placements" ? "active" : ""} onClick={() => setTab("placements")}>Posicionamentos</button>
      <button type="button" className={tab === "advanced" ? "active" : ""} onClick={() => setTab("advanced")}>Avançado</button>
    </nav>

    {tab === "audience" && <div className="aii-tv-panel">
      <section className="aii-tv-card"><header><div><b>Idade e gênero</b><small>A Meta pode restringir estes controles em categorias especiais como Housing.</small></div></header><div className="aii-tv-inline-fields"><label>Idade mínima<input type="number" min={13} max={65} value={targeting.age_min ?? ""} placeholder="Automático" onChange={(e) => mutate((next) => { const value = Number(e.target.value); if (e.target.value && Number.isFinite(value)) next.age_min = value; else delete next.age_min; })}/></label><label>Idade máxima<input type="number" min={13} max={65} value={targeting.age_max ?? ""} placeholder="Automático" onChange={(e) => mutate((next) => { const value = Number(e.target.value); if (e.target.value && Number.isFinite(value)) next.age_max = value; else delete next.age_max; })}/></label></div><div className="aii-tv-choice-row"><button type="button" className={allGenders ? "selected" : ""} onClick={() => mutate((next) => delete next.genders)}>Todos</button><button type="button" className={!allGenders && genderValues.includes(1) ? "selected" : ""} onClick={() => mutate((next) => { const current = array<number>(next.genders).map(Number).filter((n) => n === 1 || n === 2); const updated = current.includes(1) ? current.filter((n) => n !== 1) : [...current, 1]; if (!updated.length || updated.length === 2) delete next.genders; else next.genders = updated; })}>Homens</button><button type="button" className={!allGenders && genderValues.includes(2) ? "selected" : ""} onClick={() => mutate((next) => { const current = array<number>(next.genders).map(Number).filter((n) => n === 1 || n === 2); const updated = current.includes(2) ? current.filter((n) => n !== 2) : [...current, 2]; if (!updated.length || updated.length === 2) delete next.genders; else next.genders = updated; })}>Mulheres</button></div></section>

      <section className="aii-tv-card"><header><div><b>Públicos personalizados incluídos</b><small>Use o nome para leitura e o ID real do público para a Meta.</small></div></header><ObjectEditor values={customAudiences} onChange={(values) => mutate((next) => { if (values.length) next.custom_audiences = values; else delete next.custom_audiences; })}/></section>
      <section className="aii-tv-card danger-soft"><header><div><b>Públicos personalizados excluídos</b><small>Quem estiver aqui fica fora da entrega.</small></div></header><ObjectEditor values={excludedAudiences} onChange={(values) => mutate((next) => { if (values.length) next.excluded_custom_audiences = values; else delete next.excluded_custom_audiences; })}/></section>

      <section className="aii-tv-card"><header><div><b>Detalhamento</b><small>Interesses, comportamentos, cargos e outros critérios. Cada grupo preserva a estrutura original da Meta.</small></div><button type="button" onClick={() => mutate((next) => { const groups = array<Row>(next.flexible_spec); groups.push({}); next.flexible_spec = groups; })}>+ Grupo</button></header>{flexibleSpec.length ? flexibleSpec.map((group, index) => <DetailGroupEditor key={index} title={`Grupo ${index + 1}`} group={group} removable onRemove={() => mutate((next) => { const groups = array<Row>(next.flexible_spec).filter((_, i) => i !== index); if (groups.length) next.flexible_spec = groups; else delete next.flexible_spec; })} onChange={(updated) => mutate((next) => { const groups = array<Row>(next.flexible_spec); groups[index] = updated; next.flexible_spec = groups; })}/>) : <div className="aii-tv-empty">Sem detalhamento manual. O conjunto pode estar amplo/Advantage+.</div>}</section>
      <section className="aii-tv-card danger-soft"><header><div><b>Exclusões de detalhamento</b><small>Critérios removidos do público, além dos públicos personalizados acima.</small></div></header><DetailGroupEditor title="Excluir quem corresponder" group={exclusions} onChange={(updated) => mutate((next) => { if (Object.keys(updated).length) next.exclusions = updated; else delete next.exclusions; })}/></section>
      <section className="aii-tv-card"><header><div><b>Idiomas</b><small>IDs de locale usados pela Meta. Vazio mantém o comportamento atual/automático.</small></div></header><TagEditor values={stringArray(targeting.locales)} placeholder="Locale ID" onChange={(values) => mutate((next) => { if (values.length) next.locales = values.map((v) => Number(v)).filter(Number.isFinite); else delete next.locales; })}/></section>
    </div>}

    {tab === "location" && <div className="aii-tv-panel">
      <section className="aii-tv-card"><header><div><b>Países</b><small>Códigos como BR, US, PT.</small></div></header><TagEditor values={countries} placeholder="Ex.: BR" onChange={(values) => mutate((next) => { next.geo_locations = { ...(next.geo_locations || {}) }; if (values.length) next.geo_locations.countries = values.map((v) => v.toUpperCase()); else delete next.geo_locations.countries; cleanupObject(next.geo_locations, "countries"); cleanupObject(next, "geo_locations"); })}/></section>
      <section className="aii-tv-card"><header><div><b>Regiões</b><small>Mantém nome e chave retornados pela Meta.</small></div></header><ObjectEditor values={regions} idKey="key" idPlaceholder="Chave Meta" namePlaceholder="Nome da região" onChange={(values) => mutate((next) => { next.geo_locations = { ...(next.geo_locations || {}) }; if (values.length) next.geo_locations.regions = values; else delete next.geo_locations.regions; cleanupObject(next, "geo_locations"); })}/></section>
      <section className="aii-tv-card"><header><div><b>Cidades</b><small>Raio é opcional. Para adicionar uma cidade nova, informe a chave de localização da Meta.</small></div></header><div className="aii-tv-city-list">{cities.map((city, index) => <div className="aii-tv-city" key={`${city.key || index}`}><div><b>{city.name || city.key || `Cidade ${index + 1}`}</b><small>{city.key || "sem chave"}</small></div><label>Raio<input type="number" min={1} value={city.radius ?? ""} onChange={(e) => mutate((next) => { const list = array<ObjectItem>(next.geo_locations?.cities); const value = Number(e.target.value); list[index] = { ...list[index], ...(e.target.value && Number.isFinite(value) ? { radius: value } : {}) }; if (!e.target.value) delete list[index].radius; next.geo_locations = { ...(next.geo_locations || {}), cities: list }; })}/></label><select value={city.distance_unit || "kilometer"} onChange={(e) => mutate((next) => { const list = array<ObjectItem>(next.geo_locations?.cities); list[index] = { ...list[index], distance_unit: e.target.value }; next.geo_locations = { ...(next.geo_locations || {}), cities: list }; })}><option value="kilometer">km</option><option value="mile">milhas</option></select><button type="button" onClick={() => mutate((next) => { const list = array<ObjectItem>(next.geo_locations?.cities).filter((_, i) => i !== index); next.geo_locations = { ...(next.geo_locations || {}) }; if (list.length) next.geo_locations.cities = list; else delete next.geo_locations.cities; cleanupObject(next, "geo_locations"); })}>×</button></div>)}</div><CityAdder onAdd={(city) => mutate((next) => { const list = array<ObjectItem>(next.geo_locations?.cities); list.push(city); next.geo_locations = { ...(next.geo_locations || {}), cities: list }; })}/></section>
      <section className="aii-tv-card"><header><div><b>CEPs / ZIPs</b><small>Chaves de localização retornadas pela Meta.</small></div></header><ObjectEditor values={zips} idKey="key" idPlaceholder="Chave Meta" namePlaceholder="CEP / nome" onChange={(values) => mutate((next) => { next.geo_locations = { ...(next.geo_locations || {}) }; if (values.length) next.geo_locations.zips = values; else delete next.geo_locations.zips; cleanupObject(next, "geo_locations"); })}/></section>
      <section className="aii-tv-card"><header><div><b>Tipo de presença</b><small>Onde a pessoa mora ou esteve recentemente.</small></div></header><CheckGrid options={[["home", "Mora nesta localização"], ["recent", "Esteve recentemente"]]} selected={locationTypes} onChange={(values) => mutate((next) => { next.geo_locations = { ...(next.geo_locations || {}) }; if (values.length) next.geo_locations.location_types = values; else delete next.geo_locations.location_types; cleanupObject(next, "geo_locations"); })}/></section>
      {!countries.length && !regions.length && !cities.length && !zips.length ? <div className="aii-tv-warning">Nenhuma localização explícita foi identificada no objeto. Evite salvar um conjunto sem uma geografia válida; a Meta pode rejeitar a alteração.</div> : null}
    </div>}

    {tab === "placements" && <div className="aii-tv-panel">
      <section className="aii-tv-card"><header><div><b>Distribuição</b><small>Automático preserva Advantage+ placements. Manual permite escolher plataformas e posições.</small></div></header><div className="aii-tv-choice-row"><button type="button" className={autoPlacements ? "selected" : ""} onClick={() => mutate((next) => { delete next.publisher_platforms; Object.keys(POSITIONS).forEach((key) => delete next[key]); })}>Advantage+ / automático</button><button type="button" className={!autoPlacements ? "selected" : ""} onClick={() => mutate((next) => { if (!array(next.publisher_platforms).length) next.publisher_platforms = PLATFORMS.map(([value]) => value); })}>Manual</button></div>{!autoPlacements ? <><CheckGrid options={PLATFORMS as unknown as Array<readonly [string, string]>} selected={publishers} onChange={(values) => mutate((next) => { if (values.length) next.publisher_platforms = values; else delete next.publisher_platforms; })}/>{Object.entries(POSITIONS).map(([field, options]) => {
        const platform = field.replace("_positions", "");
        if (publishers.length && !publishers.includes(platform)) return null;
        const current = stringArray(targeting[field]);
        const merged = [...options, ...current.filter((value) => !options.some(([known]) => known === value)).map((value) => [value, value] as [string, string])];
        const title = platform === "facebook" ? "Facebook" : platform === "instagram" ? "Instagram" : platform === "messenger" ? "Messenger" : "Audience Network";
        return <div className="aii-tv-placement-block" key={field}><b>{title}</b><CheckGrid options={merged} selected={current} onChange={(values) => mutate((next) => { if (values.length) next[field] = values; else delete next[field]; })}/><small>Sem seleção específica = todas as posições permitidas dessa plataforma.</small></div>;
      })}</> : null}</section>
      <section className="aii-tv-card"><header><div><b>Dispositivos</b><small>Vazio significa todos os dispositivos aceitos.</small></div></header><div className="aii-tv-choice-row"><button type="button" className={allDevices ? "selected" : ""} onClick={() => mutate((next) => delete next.device_platforms)}>Todos</button><button type="button" className={!allDevices && devicePlatforms.includes("mobile") ? "selected" : ""} onClick={() => mutate((next) => { const current = stringArray(next.device_platforms); const base = current.length ? current : ["mobile", "desktop"]; const updated = base.includes("mobile") ? base.filter((v) => v !== "mobile") : [...base, "mobile"]; if (!updated.length || updated.length === 2) delete next.device_platforms; else next.device_platforms = updated; })}>Mobile</button><button type="button" className={!allDevices && devicePlatforms.includes("desktop") ? "selected" : ""} onClick={() => mutate((next) => { const current = stringArray(next.device_platforms); const base = current.length ? current : ["mobile", "desktop"]; const updated = base.includes("desktop") ? base.filter((v) => v !== "desktop") : [...base, "desktop"]; if (!updated.length || updated.length === 2) delete next.device_platforms; else next.device_platforms = updated; })}>Desktop</button></div></section>
      <section className="aii-tv-card"><header><div><b>Sistemas operacionais</b><small>Ex.: iOS, Android. Preserve vazio para não restringir.</small></div></header><TagEditor values={stringArray(targeting.user_os)} placeholder="Sistema operacional" onChange={(values) => mutate((next) => { if (values.length) next.user_os = values; else delete next.user_os; })}/></section>
      <section className="aii-tv-card"><header><div><b>Modelos / dispositivos</b><small>Restrições específicas de device retornadas pela Meta.</small></div></header><TagEditor values={stringArray(targeting.user_device)} placeholder="Dispositivo" onChange={(values) => mutate((next) => { if (values.length) next.user_device = values; else delete next.user_device; })}/></section>
      <section className="aii-tv-card"><header><div><b>Operadoras</b><small>Filtro de wireless carrier, quando existir.</small></div></header><TagEditor values={stringArray(targeting.wireless_carrier)} placeholder="Operadora" onChange={(values) => mutate((next) => { if (values.length) next.wireless_carrier = values; else delete next.wireless_carrier; })}/></section>
    </div>}

    {tab === "advanced" && <div className="aii-tv-panel">
      <section className="aii-tv-card advanced"><header><div><b>Targeting JSON completo</b><small>Use apenas quando precisar de um campo que ainda não tem controle visual. O JSON continua sendo a fonte final enviada ao backend.</small></div></header><textarea className={rawError ? "invalid" : ""} value={raw} spellCheck={false} onChange={(e) => { const nextRaw = e.target.value; setRaw(nextRaw); setNativeTextareaValue(textarea, nextRaw); try { setTargeting(parseTargeting(nextRaw)); setRawError(""); } catch { setRawError("JSON inválido. Corrija antes de salvar."); } }}/>{rawError ? <p className="aii-tv-json-error">{rawError}</p> : null}{unknownTopLevel.length ? <p className="aii-tv-preserved">Campos preservados sem controle visual: {unknownTopLevel.join(", ")}.</p> : <p className="aii-tv-preserved">Todos os campos reconhecidos permanecem sincronizados com os controles visuais.</p>}</section>
    </div>}
    <div className="aii-tv-footnote">Alterações incompatíveis com objetivo, categoria especial, Advantage+ ou políticas da conta continuam sendo bloqueadas pela própria Meta no preflight/salvamento.</div>
  </div>, host);
}

function CityAdder({ onAdd }: { onAdd: (city: ObjectItem) => void }) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [radius, setRadius] = useState("");
  const [unit, setUnit] = useState("kilometer");
  const add = () => {
    const cleanKey = compact(key);
    if (!cleanKey) return;
    const numericRadius = Number(radius);
    onAdd({ key: cleanKey, ...(compact(name) ? { name: compact(name) } : {}), ...(radius && Number.isFinite(numericRadius) ? { radius: numericRadius, distance_unit: unit } : {}) });
    setName(""); setKey(""); setRadius("");
  };
  return <div className="aii-tv-add city"><input value={name} placeholder="Cidade" onChange={(e) => setName(e.target.value)} /><input value={key} placeholder="Chave Meta" onChange={(e) => setKey(e.target.value)} /><input type="number" min={1} value={radius} placeholder="Raio" onChange={(e) => setRadius(e.target.value)} /><select value={unit} onChange={(e) => setUnit(e.target.value)}><option value="kilometer">km</option><option value="mile">milhas</option></select><button type="button" onClick={add}>Adicionar</button></div>;
}

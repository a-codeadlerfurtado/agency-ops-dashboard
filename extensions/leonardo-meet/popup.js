const statusEl = document.getElementById("status");
const pendingEl = document.getElementById("pending");
const integrationsEl = document.getElementById("integrations");
const liveButton = document.getElementById("live");
const settingsButton = document.getElementById("settings");
const retryButton = document.getElementById("retry");

function renderIntegrations(providers = []) {
  integrationsEl.textContent = "";
  for (const provider of providers) {
    const row = document.createElement("div");
    row.className = "integration";
    const name = document.createElement("div");
    name.className = "integration-name";
    name.textContent = provider.label || provider.provider_key;
    const state = document.createElement("div");
    const active = provider.connection?.status === "ACTIVE" || provider.provider_key === "ZAPI_NOTIFIER";
    state.className = `integration-state ${active ? "active" : "pending"}`;
    state.textContent = active ? "Conectado" : "Disponível";
    row.append(name, state);
    integrationsEl.append(row);
  }
}

async function render() {
  const [result, integrations] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_STATUS" }),
    chrome.runtime.sendMessage({ type: "GET_INTEGRATIONS" }).catch(() => ({ providers: [] })),
  ]);  if (!result?.paired) {
    statusEl.className = "status bad";
    statusEl.textContent = "Este Chrome ainda não está conectado ao Dashboard.";
  } else if (result?.state?.active) {
    statusEl.className = "status rec";
    statusEl.textContent = `REC · ${result.state.title || result.state.meeting_code || "Google Meet"}`;
  } else if (result?.state?.error) {
    statusEl.className = "status bad";
    statusEl.textContent = `Atenção: ${result.state.error}`;
  } else {
    statusEl.className = "status ok";
    statusEl.textContent = `Ativo para ${result.device?.owner_person || "este colaborador"}.`;
  }
  pendingEl.textContent = result?.pending_uploads ? `${result.pending_uploads} reunião(ões) aguardando reenvio.` : "Nenhuma reunião pendente de envio.";
  renderIntegrations(integrations?.providers || []);
}

liveButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) await chrome.sidePanel.open({ tabId: tab.id });
  window.close();
});
settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  await chrome.runtime.sendMessage({ type: "FLUSH_OUTBOX" });
  retryButton.disabled = false;
  await render();
});

render().catch((error) => {
  statusEl.className = "status bad";
  statusEl.textContent = String(error?.message || error);
});
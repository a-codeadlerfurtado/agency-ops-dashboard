namespace RelatoAI.DesktopAgent;

internal sealed class AgentContext : ApplicationContext
{
    private AgentConfig? config;
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem statusItem;
    private readonly ToolStripMenuItem autoItem;
    private readonly ToolStripMenuItem finishItem;
    private readonly WhatsAppDesktopCapture capture;

    public AgentContext()
    {
        config = AgentConfig.Load();
        statusItem = new ToolStripMenuItem("Inicializando…") { Enabled = false };
        autoItem = new ToolStripMenuItem("Captura automática") { Checked = true, CheckOnClick = true };
        finishItem = new ToolStripMenuItem("Finalizar e enviar chamada") { Enabled = false };
        var pairItem = new ToolStripMenuItem("Parear / trocar usuário");
        var exitItem = new ToolStripMenuItem("Sair");
        var menu = new ContextMenuStrip();
        menu.Items.AddRange([statusItem, new ToolStripSeparator(), autoItem, finishItem, pairItem, new ToolStripSeparator(), exitItem]);
        tray = new NotifyIcon { Icon = SystemIcons.Information, Text = "Relato AI Desktop Agent", Visible = true, ContextMenuStrip = menu };
        capture = new WhatsAppDesktopCapture(() => config);
        WireEvents();
        autoItem.CheckedChanged += (_, _) => capture.Enabled = autoItem.Checked;
        finishItem.Click += async (_, _) => await capture.FinishManualAsync();
        pairItem.Click += async (_, _) => await PairAsync();
        exitItem.Click += (_, _) => ExitThread();
        UpdateStatus(config is null ? "Não pareado" : $"Conectado · {config.OwnerPerson}");
        if (config is null) BeginInvokePairing();
    }

    private void WireEvents()
    {
        capture.StatusChanged += text => Post(() => UpdateStatus(text));
        capture.CallStarted += (_, contact) => Post(() =>
        {
            finishItem.Enabled = true;
            tray.Text = "Relato AI · REC WhatsApp";
            tray.ShowBalloonTip(2000, "Relato AI", $"Gravando chamada com {contact}", ToolTipIcon.Info);
        });
        capture.CallFinished += (sessionId, ok, error) => Post(() =>
        {
            finishItem.Enabled = false;
            tray.Text = "Relato AI Desktop Agent";
            if (ok)
            {
                tray.ShowBalloonTip(2500, "Relato AI", "Ligação enviada para transcrição.", ToolTipIcon.Info);
                using var form = new FeedbackForm(config, sessionId);
                form.ShowDialog();
            }
            else tray.ShowBalloonTip(3500, "Relato AI", error ?? "Falha ao enviar ligação.", ToolTipIcon.Error);
        });
    }

    private void BeginInvokePairing()
    {
        var timer = new System.Windows.Forms.Timer { Interval = 600 };
        timer.Tick += async (_, _) => { timer.Stop(); timer.Dispose(); await PairAsync(); };
        timer.Start();
    }
    private async Task PairAsync()
    {
        using var form = new PairingForm();
        if (form.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(form.PairingCode)) return;
        try
        {
            var result = await new RelatoApi().PairAsync(form.PairingCode);
            config = AgentConfig.Create(result.DeviceId, result.OwnerPerson, result.DeviceToken);
            config.Save();
            UpdateStatus($"Conectado · {config.OwnerPerson}");
            tray.ShowBalloonTip(2000, "Relato AI", "Desktop Agent conectado.", ToolTipIcon.Info);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Relato AI", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void UpdateStatus(string text)
    {
        statusItem.Text = text.Length > 70 ? text[..70] : text;
    }

    private void Post(Action action)
    {
        var form = Application.OpenForms.Count > 0 ? Application.OpenForms[0] : null;
        if (form is not null && form.InvokeRequired)
            form.BeginInvoke(action);
        else action();
    }

    protected override void ExitThreadCore()
    {
        capture.Dispose();
        tray.Visible = false;
        tray.Dispose();
        base.ExitThreadCore();
    }
}
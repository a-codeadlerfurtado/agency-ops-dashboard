namespace RelatoAI.DesktopAgent;

internal sealed class AgentContext : ApplicationContext
{
    private AgentConfig? config;
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem statusItem;
    private readonly ToolStripMenuItem autoItem;
    private readonly ToolStripMenuItem finishItem;
    private readonly WhatsAppDesktopCapture capture;
    private readonly MeetDesktopCapture meetCapture;
    private readonly MeetLocalBridge meetBridge;
    private readonly AgentUpdater updater;
    private readonly Control dispatcher = new();
    private RecordingIndicatorForm? recordingIndicator;

    public AgentContext()
    {
        config = AgentConfig.Load();
        dispatcher.CreateControl();
        statusItem = new ToolStripMenuItem("Inicializando…") { Enabled = false };
        autoItem = new ToolStripMenuItem("Captura automática") { Checked = true, CheckOnClick = true };
        finishItem = new ToolStripMenuItem("Forçar encerramento (emergência)") { Enabled = false };
        var pairItem = new ToolStripMenuItem("Parear / trocar usuário");
        var exitItem = new ToolStripMenuItem("Sair");
        var menu = new ContextMenuStrip();
        menu.Items.AddRange([statusItem, new ToolStripSeparator(), autoItem, finishItem, pairItem, new ToolStripSeparator(), exitItem]);
        tray = new NotifyIcon { Icon = SystemIcons.Information, Text = "Relato AI Desktop Agent", Visible = true, ContextMenuStrip = menu };
        capture = new WhatsAppDesktopCapture(() => config);
        meetCapture = new MeetDesktopCapture(() => config);
        meetBridge = new MeetLocalBridge(meetCapture);
        meetBridge.Start();
        WireEvents();
        updater = new AgentUpdater(
            () => config,
            text => Post(() => UpdateStatus(text)),
            () => Post(ExitThread));
        autoItem.CheckedChanged += (_, _) => capture.Enabled = autoItem.Checked;
        finishItem.Click += async (_, _) =>
        {
            if (meetCapture.IsRecording) await meetCapture.FinishAsync("manual_stop");
            else await capture.FinishManualAsync();
        };
        pairItem.Click += async (_, _) => await PairAsync();
        exitItem.Click += (_, _) => ExitThread();
        UpdateStatus(config is null ? "Não pareado" : $"Conectado · {config.OwnerPerson}");
        if (config is null) BeginInvokePairing();
    }

    private void WireEvents()
    {
        capture.StatusChanged += text => Post(() => UpdateStatus(text));
        meetCapture.StatusChanged += text => Post(() => UpdateStatus(text));
        meetCapture.MeetingStarted += code => Post(() =>
        {
            finishItem.Enabled = true;
            tray.Text = "Relato AI · REC Meet";
            recordingIndicator ??= new RecordingIndicatorForm();
            recordingIndicator.ShowIndicator("Google Meet");
            tray.ShowBalloonTip(1500, "Relato AI", $"Gravando Google Meet · {code}", ToolTipIcon.Info);
        });
        meetCapture.MeetingFinished += (localSessionId, ok, error) => Post(() =>
        {
            finishItem.Enabled = false;
            tray.Text = "Relato AI Desktop Agent";
            recordingIndicator?.HideIndicator();
            tray.ShowBalloonTip(ok ? 1800 : 3500, "Relato AI",
                ok ? "Meet salvo e transcrito." : (error ?? "Falha ao finalizar Meet."),
                ok ? ToolTipIcon.Info : ToolTipIcon.Error);
            if (ok && !string.IsNullOrWhiteSpace(localSessionId))
            {
                using var form = new FeedbackForm(config, localSessionId, "MEET");
                form.ShowDialog();
            }
        });
        capture.CallStarted += (_, contact) => Post(() =>
        {
            finishItem.Enabled = true;
            tray.Text = "Relato AI · REC WhatsApp";
            recordingIndicator ??= new RecordingIndicatorForm();
            recordingIndicator.ShowIndicator("WhatsApp Desktop");
            tray.ShowBalloonTip(2000, "Relato AI", $"Gravando chamada com {contact}", ToolTipIcon.Info);
        });
        capture.CallEnded += (sessionId, _) => Post(() =>
        {
            finishItem.Enabled = false;
            tray.Text = "Relato AI Desktop Agent";
            recordingIndicator?.HideIndicator();
            tray.ShowBalloonTip(1500, "Relato AI", "Ligação encerrada. Enviando em segundo plano...", ToolTipIcon.Info);
            using var form = new FeedbackForm(config, sessionId);
            form.ShowDialog();
        });
        capture.CallFinished += (_, ok, error) => Post(() =>
        {
            if (ok)
                tray.ShowBalloonTip(2200, "Relato AI", "Ligação enviada para transcrição.", ToolTipIcon.Info);
            else
                tray.ShowBalloonTip(3500, "Relato AI", error ?? "Falha ao enviar ligação.", ToolTipIcon.Error);
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
        var display = text.Length > 70 ? text[..70] : text;
        if (statusItem.Text == display) return;
        statusItem.Text = display;
        try
        {
            var dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RelatoAI");
            Directory.CreateDirectory(dir);
            File.AppendAllText(
                Path.Combine(dir, "desktop-agent.log"),
                $"{DateTimeOffset.Now:O}\t{text}{Environment.NewLine}");
        }
        catch { }
    }

    private void Post(Action action)
    {
        if (dispatcher.IsDisposed) return;
        dispatcher.BeginInvoke(action);
    }

    protected override void ExitThreadCore()
    {
        recordingIndicator?.Dispose();
        updater.Dispose();
        meetBridge.Dispose();
        meetCapture.Dispose();
        capture.Dispose();
        dispatcher.Dispose();
        tray.Visible = false;
        tray.Dispose();
        base.ExitThreadCore();
    }
}

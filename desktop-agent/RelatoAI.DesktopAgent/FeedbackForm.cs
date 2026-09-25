namespace RelatoAI.DesktopAgent;

internal sealed class FeedbackForm : Form
{
    private static readonly Color Bg = Color.FromArgb(7, 10, 13);
    private static readonly Color Panel = Color.FromArgb(20, 25, 30);
    private static readonly Color Panel2 = Color.FromArgb(14, 19, 23);
    private static readonly Color Line = Color.FromArgb(53, 65, 75);
    private static readonly Color TextMain = Color.FromArgb(237, 244, 248);
    private static readonly Color Muted = Color.FromArgb(166, 180, 191);
    private static readonly Color Accent = Color.FromArgb(255, 122, 47);
    private static readonly Color Blue = Color.FromArgb(118, 198, 255);

    private readonly AgentConfig? config;
    private readonly string sessionId;
    private readonly string interactionChannel;
    private readonly ComboBox mood = SelectBox(220);
    private readonly ComboBox tone = SelectBox(220);
    private readonly ComboBox direction = SelectBox(220);
    private readonly NumericUpDown receptivity = Score();
    private readonly NumericUpDown trust = Score();
    private readonly NumericUpDown risk = Score();
    private readonly CheckedListBox tags = new();
    private readonly TextBox note = new();
    private readonly Button saveButton = new();
    private readonly Button laterButton = new();
    private readonly Label contactStatus = new();
    private readonly Label contactDetail = new();
    private readonly ComboBox clientBinding = SelectBox(532);
    private readonly Panel prospectCard = Card(570, 1040);
    private readonly TextBox prospectName = Input(246);
    private readonly TextBox prospectCompany = Input(246);
    private readonly TextBox prospectEmail = Input(246);
    private readonly TextBox prospectPhone = Input(246);
    private readonly TextBox prospectCity = Input(246);
    private readonly TextBox prospectInstagram = Input(246);
    private readonly TextBox prospectMarketing = Input(246);
    private readonly NumericUpDown prospectBrokers = new() { Minimum = 0, Maximum = 10000, Width = 246, BackColor = Panel2, ForeColor = TextMain, BorderStyle = BorderStyle.FixedSingle };
    private readonly TextBox prospectPain = Input(516);
    private readonly TextBox prospectGoals = Input(516);
    private readonly TextBox prospectInterest = Input(516);
    private readonly TextBox prospectObjections = Input(516);
    private readonly TextBox prospectUrgency = Input(516);
    private readonly TextBox prospectDecisionRole = Input(516);
    private readonly TextBox prospectStructure = Input(516);
    private readonly TextBox prospectBuyingSignals = Input(516);
    private readonly TextBox prospectClosingRisks = Input(516);
    private readonly TextBox prospectBriefing = new() { Width = 516, Height = 86, Multiline = true, ScrollBars = ScrollBars.Vertical, BackColor = Panel2, ForeColor = TextMain, BorderStyle = BorderStyle.FixedSingle };
    private readonly TextBox prospectNextStep = Input(516);
    private readonly DateTimePicker prospectNextStepAt = new() { Width = 246, ShowCheckBox = true, Checked = false, Format = DateTimePickerFormat.Custom, CustomFormat = "dd/MM/yyyy HH:mm", CalendarMonthBackground = Panel2 };
    private FeedbackContext? feedbackContext;
    private bool contextReady;
    private bool submitted;

    private sealed record BindingOption(string? Id, string Name, bool NoClient = false, bool Prospect = false)
    {
        public override string ToString() => Name;
    }

    public FeedbackForm(AgentConfig? config, string sessionId, string interactionChannel = "WHATSAPP_DESKTOP")
    {
        this.config = config;
        this.sessionId = sessionId;
        this.interactionChannel = string.IsNullOrWhiteSpace(interactionChannel) ? "WHATSAPP_DESKTOP" : interactionChannel.Trim().ToUpperInvariant();
        Text = "Relato AI · Avaliação da call";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = true;
        TopMost = true;
        BackColor = Bg;
        ForeColor = TextMain;
        Font = new Font("Segoe UI", 10F, FontStyle.Regular);
        ClientSize = new Size(650, 760);
        MinimumSize = new Size(650, 760);
        MaximumSize = new Size(650, 760);

        mood.Items.AddRange(["Ótimo", "Bom", "Neutro", "Preocupado", "Irritado"]);
        tone.Items.AddRange(["Animado", "Receptivo", "Neutro", "Frio", "Defensivo", "Impaciente"]);
        direction.Items.AddRange(["Melhorou", "Igual", "Piorou"]);
        mood.SelectedIndex = 2;
        tone.SelectedIndex = 2;
        direction.SelectedIndex = 1;
        BuildUi();
        prospectCard.Visible = false;
        saveButton.Enabled = false;
        clientBinding.SelectedIndexChanged += (_, _) =>
        {
            var option = clientBinding.SelectedItem as BindingOption;
            prospectCard.Visible = option?.Prospect == true;
            if (option?.Prospect == true)
            {
                if (string.IsNullOrWhiteSpace(prospectName.Text)) prospectName.Text = feedbackContext?.RemoteName ?? "";
                if (string.IsNullOrWhiteSpace(prospectPhone.Text) && !string.IsNullOrWhiteSpace(feedbackContext?.RemotePhone)) prospectPhone.Text = $"+{feedbackContext.RemotePhone}";
            }
            if (feedbackContext?.RequiresSelection == true)
                saveButton.Enabled = CanSaveNow();
        };
        prospectName.TextChanged += (_, _) => { if (contextReady) saveButton.Enabled = CanSaveNow(); };
        Shown += async (_, _) => { Activate(); BringToFront(); await LoadContextAsync(); };
    }

    private void BuildUi()
    {
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 3, BackColor = Bg };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 116));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 86));
        root.Controls.Add(BuildHeader(), 0, 0);
        root.Controls.Add(BuildBody(), 0, 1);
        root.Controls.Add(BuildFooter(), 0, 2);
        Controls.Add(root);
    }

    private Control BuildHeader()
    {
        var header = new Panel { Dock = DockStyle.Fill, BackColor = Panel2, Padding = new Padding(28, 20, 28, 16) };
        header.Controls.Add(new Panel { Dock = DockStyle.Left, Width = 4, BackColor = Accent });
        var brand = new Label { Text = "RELATO AI  •  OPS", ForeColor = Accent, Font = new Font(Font.FontFamily, 9F, FontStyle.Bold), AutoSize = true, Location = new Point(28, 18) };
        var title = new Label { Text = "Como essa call terminou?", ForeColor = TextMain, Font = new Font(Font.FontFamily, 18F, FontStyle.Bold), AutoSize = true, Location = new Point(28, 43) };
        var sub = new Label { Text = "Sua leitura humana complementa a transcrição e ajuda a detectar risco, confiança e próximos passos.", ForeColor = Muted, Font = new Font(Font.FontFamily, 9.5F), AutoSize = true, MaximumSize = new Size(570, 40), Location = new Point(30, 78) };
        header.Controls.Add(brand);
        header.Controls.Add(title);
        header.Controls.Add(sub);
        return header;
    }

    private Control BuildBody()
    {
        var body = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            BackColor = Bg,
            Padding = new Padding(24, 20, 24, 20)
        };

        body.Controls.Add(BuildContactCard());
        body.Controls.Add(BuildProspectCard());
        body.Controls.Add(SectionTitle("Leitura da conversa", "Percepção geral da call"));
        body.Controls.Add(FieldRow("Humor", mood));
        body.Controls.Add(FieldRow("Tom de voz", tone));
        body.Controls.Add(SectionTitle("Sinais da relação", "Notas rápidas de 1 a 5"));
        body.Controls.Add(MetricRow("Receptividade", "Quanto ele esteve aberto à conversa", receptivity));
        body.Controls.Add(MetricRow("Confiança", "Nível de segurança e conexão percebido", trust));
        body.Controls.Add(MetricRow("Risco percebido", "Chance de atrito, perda ou churn", risk));
        body.Controls.Add(FieldRow("Relação após a call", direction));
        body.Controls.Add(BuildSignalsCard());
        body.Controls.Add(BuildNotesCard());
        return body;
    }

    private Control BuildContactCard()
    {
        var card = Card(570, 150);
        card.Margin = new Padding(0, 0, 0, 16);
        contactStatus.Text = "Identificando contato...";
        contactStatus.ForeColor = Blue;
        contactStatus.Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold);
        contactStatus.AutoSize = true;
        contactStatus.Location = new Point(18, 14);
        contactDetail.Text = "Cruzando número, grupos e cadastro de clientes.";
        contactDetail.ForeColor = Muted;
        contactDetail.AutoSize = true;
        contactDetail.MaximumSize = new Size(532, 42);
        contactDetail.Location = new Point(18, 42);
        clientBinding.Location = new Point(18, 92);
        clientBinding.Visible = false;
        card.Controls.Add(contactStatus);
        card.Controls.Add(contactDetail);
        card.Controls.Add(clientBinding);
        return card;
    }

    private Control BuildProspectCard()
    {
        prospectCard.Margin = new Padding(0, 0, 0, 16);
        prospectCard.Controls.Clear();
        prospectCard.Controls.Add(new Label { Text = "PROSPECT COMERCIAL", ForeColor = Accent, Font = new Font(Font.FontFamily, 9F, FontStyle.Bold), AutoSize = true, Location = new Point(18, 14) });
        prospectCard.Controls.Add(new Label { Text = "Preencha o contexto que o closer precisa receber.", ForeColor = Muted, AutoSize = true, Location = new Point(18, 38) });

        AddProspectField("Nome *", prospectName, 18, 70);
        AddProspectField("Empresa / imobiliária", prospectCompany, 306, 70);
        AddProspectField("E-mail", prospectEmail, 18, 126);
        AddProspectField("Telefone", prospectPhone, 306, 126);
        AddProspectField("Cidade / região", prospectCity, 18, 182);
        AddProspectField("Instagram / site", prospectInstagram, 306, 182);
        AddProspectField("Investimento em marketing", prospectMarketing, 18, 238);
        AddProspectField("Nº de corretores", prospectBrokers, 306, 238);
        AddProspectField("Dores (principal primeiro; separe por ;)", prospectPain, 18, 294);
        AddProspectField("Objetivos (separe por ;)", prospectGoals, 18, 350);
        AddProspectField("Interesse / serviço (separe por ;)", prospectInterest, 18, 406);
        AddProspectField("Objeções (separe por ;)", prospectObjections, 18, 462);
        AddProspectField("Urgência / timing", prospectUrgency, 18, 518);
        AddProspectField("Quem decide / papel na decisão", prospectDecisionRole, 18, 574);
        AddProspectField("Estrutura atual", prospectStructure, 18, 630);
        AddProspectField("Sinais de compra (separe por ;)", prospectBuyingSignals, 18, 686);
        AddProspectField("Riscos de fechamento (separe por ;)", prospectClosingRisks, 18, 742);
        AddProspectField("Briefing IA para o closer", prospectBriefing, 18, 798);
        AddProspectField("Próximo passo", prospectNextStep, 18, 910);
        AddProspectField("Data do próximo passo", prospectNextStepAt, 18, 966);
        return prospectCard;
    }

    private void AddProspectField(string label, Control control, int x, int y)
    {
        prospectCard.Controls.Add(new Label { Text = label, ForeColor = Muted, AutoSize = true, Location = new Point(x, y) });
        control.Location = new Point(x, y + 19);
        prospectCard.Controls.Add(control);
    }

    private Control BuildSignalsCard()
    {
        var card = Card(570, 142);
        var title = new Label { Text = "Sinais percebidos", ForeColor = TextMain, Font = new Font(Font.FontFamily, 10F, FontStyle.Bold), AutoSize = true, Location = new Point(18, 14) };
        var sub = new Label { Text = "Opcional · marque tudo que fez sentido", ForeColor = Muted, AutoSize = true, Location = new Point(18, 38) };
        tags.SetBounds(18, 64, 532, 60);
        tags.BackColor = Panel2;
        tags.ForeColor = TextMain;
        tags.BorderStyle = BorderStyle.FixedSingle;
        tags.CheckOnClick = true;
        tags.MultiColumn = true;
        tags.ColumnWidth = 125;
        tags.Items.AddRange(["Abertura", "Confiança", "Urgência", "Dúvida", "Objeção", "Resistência", "Frustração", "Risco"]);
        card.Controls.Add(title);
        card.Controls.Add(sub);
        card.Controls.Add(tags);
        return card;
    }

    private Control BuildNotesCard()
    {
        var card = Card(570, 150);
        var title = new Label { Text = "Nota rápida", ForeColor = TextMain, Font = new Font(Font.FontFamily, 10F, FontStyle.Bold), AutoSize = true, Location = new Point(18, 14) };
        var sub = new Label { Text = "Opcional · registre algo que só quem participou percebeu", ForeColor = Muted, AutoSize = true, Location = new Point(18, 38) };
        note.SetBounds(18, 65, 532, 66);
        note.Multiline = true;
        note.ScrollBars = ScrollBars.Vertical;
        note.BackColor = Panel2;
        note.ForeColor = TextMain;
        note.BorderStyle = BorderStyle.FixedSingle;
        note.PlaceholderText = "Ex.: ficou inseguro com prazo, pareceu mais receptivo no final...";
        card.Controls.Add(title); card.Controls.Add(sub); card.Controls.Add(note);
        return card;
    }

    private Control BuildFooter()
    {
        var footer = new Panel { Dock = DockStyle.Fill, BackColor = Panel2, Padding = new Padding(24, 16, 24, 16) };
        var line = new Panel { Dock = DockStyle.Top, Height = 1, BackColor = Line };
        laterButton.Text = "Agora não";
        laterButton.SetBounds(24, 20, 130, 46);
        StyleSecondaryButton(laterButton);
        saveButton.Text = "Salvar avaliação";
        saveButton.SetBounds(430, 20, 172, 46);
        StylePrimaryButton(saveButton);
        laterButton.Click += async (_, _) => await SubmitAsync(true);
        saveButton.Click += async (_, _) => await SubmitAsync(false);
        footer.Controls.Add(line);
        footer.Controls.Add(laterButton);
        footer.Controls.Add(saveButton);
        return footer;
    }

    private Control SectionTitle(string title, string subtitle)
    {
        var panel = new Panel { Width = 570, Height = 54, Margin = new Padding(0, 0, 0, 8) };
        panel.Controls.Add(new Label { Text = title, ForeColor = TextMain, Font = new Font(Font.FontFamily, 11F, FontStyle.Bold), AutoSize = true, Location = new Point(2, 2) });
        panel.Controls.Add(new Label { Text = subtitle, ForeColor = Muted, AutoSize = true, Location = new Point(2, 27) });
        return panel;
    }

    private Control FieldRow(string label, Control control)
    {
        var card = Card(570, 72);
        card.Margin = new Padding(0, 0, 0, 10);
        card.Controls.Add(new Label { Text = label, ForeColor = TextMain, Font = new Font(Font.FontFamily, 10F, FontStyle.Bold), AutoSize = true, Location = new Point(18, 24) });
        control.Location = new Point(330, 18);
        card.Controls.Add(control);
        return card;
    }

    private Control MetricRow(string label, string hint, Control control)
    {
        var card = Card(570, 78);
        card.Margin = new Padding(0, 0, 0, 10);
        card.Controls.Add(new Label { Text = label, ForeColor = TextMain, Font = new Font(Font.FontFamily, 10F, FontStyle.Bold), AutoSize = true, Location = new Point(18, 14) });
        card.Controls.Add(new Label { Text = hint, ForeColor = Muted, AutoSize = true, Location = new Point(18, 40) });
        control.Location = new Point(476, 20);
        card.Controls.Add(control);
        return card;
    }

    private static Panel Card(int width, int height) => new()
    {
        Width = width,
        Height = height,
        BackColor = Panel,
        Margin = new Padding(0, 0, 0, 12),
        Padding = new Padding(1)
    };

    private static ComboBox SelectBox(int width) => new()
    {
        DropDownStyle = ComboBoxStyle.DropDownList,
        Width = width,
        Height = 34,
        BackColor = Panel2,
        ForeColor = TextMain,
        FlatStyle = FlatStyle.Flat
    };

    private static TextBox Input(int width) => new()
    {
        Width = width,
        Height = 30,
        BackColor = Panel2,
        ForeColor = TextMain,
        BorderStyle = BorderStyle.FixedSingle
    };

    private static NumericUpDown Score() => new()
    {
        Minimum = 1,
        Maximum = 5,
        Value = 3,
        Width = 74,
        Height = 34,
        BackColor = Panel2,
        ForeColor = TextMain,
        BorderStyle = BorderStyle.FixedSingle,
        TextAlign = HorizontalAlignment.Center
    };

    private static void StylePrimaryButton(Button button)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 0;
        button.BackColor = Accent;
        button.ForeColor = Color.White;
        button.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
        button.Cursor = Cursors.Hand;
    }

    private static void StyleSecondaryButton(Button button)
    {
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = Line;
        button.FlatAppearance.BorderSize = 1;
        button.BackColor = Panel;
        button.ForeColor = TextMain;
        button.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
        button.Cursor = Cursors.Hand;
    }

    private async Task LoadContextAsync()
    {
        if (config is null) return;
        var api = new RelatoApi(config);
        Exception? last = null;
        for (var attempt = 0; attempt < 40; attempt++)
        {
            try
            {
                var context = await api.GetFeedbackContextAsync(sessionId);
                if (context.Pending)
                {
                    await Task.Delay(300);
                    continue;
                }
                feedbackContext = context;
                contextReady = true;
                ApplyContext(context);
                if (string.Equals(context.Workflow, "SDR_PROSPECT", StringComparison.OrdinalIgnoreCase) && !context.CommercialAnalysisReady)
                    _ = RefreshProspectSuggestionsAsync(api);
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                await Task.Delay(300);
            }
        }
        contactStatus.Text = "Identificação pendente";
        contactStatus.ForeColor = Accent;
        contactDetail.Text = last is null
            ? "Ainda estou aguardando os dados da ligação."
            : "Não consegui carregar a identificação da ligação ainda.";
    }

    private async Task RefreshProspectSuggestionsAsync(RelatoApi api)
    {
        for (var attempt = 0; attempt < 60 && !IsDisposed; attempt++)
        {
            await Task.Delay(1000);
            try
            {
                var context = await api.GetFeedbackContextAsync(sessionId);
                if (context.Pending) continue;
                if (!string.Equals(context.Workflow, "SDR_PROSPECT", StringComparison.OrdinalIgnoreCase)) return;
                feedbackContext = context;
                ApplyProspectPrefill(context.ProspectPrefill);
                if (!string.IsNullOrWhiteSpace(context.RemoteName) && string.IsNullOrWhiteSpace(prospectName.Text))
                    prospectName.Text = context.RemoteName;
                if (!string.IsNullOrWhiteSpace(context.RemotePhone) && string.IsNullOrWhiteSpace(prospectPhone.Text))
                    prospectPhone.Text = $"+{context.RemotePhone}";
                saveButton.Enabled = CanSaveNow();
                if (context.CommercialAnalysisReady)
                {
                    contactDetail.Text = "A IA já preencheu o diagnóstico comercial. Revise/corrija e salve para confirmar no CRM do closer.";
                    return;
                }
                if (context.TranscriptReady && attempt >= 45) return;
            }
            catch { }
        }
    }

    private void ApplyProspectPrefill(ProspectPrefill? value)
    {
        if (value is null) return;
        void Fill(TextBox box, string? text) { if (string.IsNullOrWhiteSpace(box.Text) && !string.IsNullOrWhiteSpace(text)) box.Text = text; }
        Fill(prospectName, value.Name);
        Fill(prospectCompany, value.Company);
        Fill(prospectEmail, value.Email);
        Fill(prospectPhone, string.IsNullOrWhiteSpace(value.Phone) ? null : $"+{value.Phone.TrimStart('+')}");
        Fill(prospectCity, value.City);
        Fill(prospectInstagram, value.Instagram);
        Fill(prospectMarketing, value.MarketingInvestment);
        if (prospectBrokers.Value == 0 && value.BrokerCount is > 0 && value.BrokerCount <= prospectBrokers.Maximum)
            prospectBrokers.Value = value.BrokerCount.Value;
        Fill(prospectPain, string.Join("; ", value.PainPoints));
        Fill(prospectGoals, string.Join("; ", value.Goals));
        Fill(prospectInterest, string.Join("; ", value.ServicesInterest));
        Fill(prospectObjections, string.Join("; ", value.Objections));
        Fill(prospectUrgency, value.Urgency);
        Fill(prospectDecisionRole, value.DecisionRole);
        Fill(prospectStructure, value.CurrentStructure);
        Fill(prospectBuyingSignals, string.Join("; ", value.BuyingSignals));
        Fill(prospectClosingRisks, string.Join("; ", value.ClosingRisks));
        Fill(prospectBriefing, value.CloserBriefing ?? value.AiSummary);
        Fill(prospectNextStep, value.NextStep);
        if (!prospectNextStepAt.Checked && !string.IsNullOrWhiteSpace(value.NextStepAt) && DateTimeOffset.TryParse(value.NextStepAt, out var nextAt))
        {
            prospectNextStepAt.Value = nextAt.LocalDateTime;
            prospectNextStepAt.Checked = true;
        }
    }

    private void ApplyContext(FeedbackContext context)
    {
        ApplyProspectPrefill(context.ProspectPrefill);
        var phone = string.IsNullOrWhiteSpace(context.RemotePhone) ? null : $"+{context.RemotePhone}";
        var person = string.IsNullOrWhiteSpace(context.RemoteName) ? phone ?? "Contato não identificado" : context.RemoteName;
        var identity = string.Join(" · ", new[] { person, phone }.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct());

        if (string.Equals(context.Workflow, "SDR_PROSPECT", StringComparison.OrdinalIgnoreCase))
        {
            contactStatus.Text = "Prospect comercial · SDR";
            contactStatus.ForeColor = Accent;
            contactDetail.Text = string.IsNullOrWhiteSpace(context.RemoteName)
                ? $"{identity}\nO Relato vai completar os dados disponíveis enquanto a transcrição processa."
                : $"{identity}\nProspect selecionado automaticamente pelo perfil SDR.";
            clientBinding.Items.Clear();
            clientBinding.Items.Add(new BindingOption(null, "Prospect comercial / possível cliente", false, true));
            clientBinding.Items.Add(new BindingOption(null, "Sem vínculo com cliente ou prospect", true));
            clientBinding.SelectedIndex = 0;
            clientBinding.Visible = true;
            prospectCard.Visible = true;
            if (string.IsNullOrWhiteSpace(prospectName.Text) && !string.IsNullOrWhiteSpace(context.RemoteName))
                prospectName.Text = context.RemoteName;
            if (string.IsNullOrWhiteSpace(prospectPhone.Text) && !string.IsNullOrWhiteSpace(context.RemotePhone))
                prospectPhone.Text = $"+{context.RemotePhone}";
            saveButton.Enabled = CanSaveNow();
            return;
        }

        if (!context.RequiresSelection)
        {
            contactStatus.Text = "Identificado automaticamente";
            contactStatus.ForeColor = Blue;
            var relation = string.Join(" • ", new[] { context.RemoteRole, context.ClientName }.Where(x => !string.IsNullOrWhiteSpace(x)));
            contactDetail.Text = string.IsNullOrWhiteSpace(relation) ? identity : $"{identity}\n{relation}";
            clientBinding.Visible = false;
            prospectCard.Visible = false;
            saveButton.Enabled = true;
            return;
        }

        contactStatus.Text = "Confirmação necessária";
        contactStatus.ForeColor = Accent;
        contactDetail.Text = $"{identity}\nNão identifiquei o vínculo com segurança. Selecione abaixo.";
        clientBinding.Items.Clear();
        clientBinding.Items.Add(new BindingOption(null, "Selecione o vínculo..."));
        foreach (var client in context.Clients)
            clientBinding.Items.Add(new BindingOption(client.Id, client.Name));
        clientBinding.Items.Add(new BindingOption(null, "Prospect comercial / possível cliente", false, true));
        clientBinding.Items.Add(new BindingOption(null, "Sem vínculo com cliente ou prospect", true));
        clientBinding.SelectedIndex = 0;
        clientBinding.Visible = true;
        saveButton.Enabled = false;
    }

    private bool HasRequiredBinding()
    {
        if (!contextReady) return false;
        if (string.Equals(feedbackContext?.Workflow, "SDR_PROSPECT", StringComparison.OrdinalIgnoreCase))
        {
            var selected = clientBinding.SelectedItem as BindingOption;
            return selected?.NoClient == true || !string.IsNullOrWhiteSpace(prospectName.Text);
        }
        if (feedbackContext?.RequiresSelection != true) return true;
        return clientBinding.SelectedItem is BindingOption option &&
            (option.Id is not null || option.NoClient || (option.Prospect && !string.IsNullOrWhiteSpace(prospectName.Text)));
    }

    private bool CanSaveNow()
    {
        if (!HasRequiredBinding()) return false;
        if (string.Equals(feedbackContext?.Workflow, "SDR_PROSPECT", StringComparison.OrdinalIgnoreCase))
            return feedbackContext?.TranscriptReady == true;
        return true;
    }

    private static string[] SplitEntries(string value) => value
        .Split([';', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .Where(x => !string.IsNullOrWhiteSpace(x))
        .Distinct(StringComparer.OrdinalIgnoreCase)
        .Take(20)
        .ToArray();

    private async Task SubmitAsync(bool dismissed)
    {
        if (submitted) return;
        submitted = true;
        saveButton.Enabled = false;
        laterButton.Enabled = false;
        saveButton.Text = dismissed ? "Fechando..." : "Salvando...";
        try
        {
            await SaveAsync(dismissed);
            DialogResult = dismissed ? DialogResult.Cancel : DialogResult.OK;
            Close();
        }
        catch (Exception ex)
        {
            submitted = false;
            saveButton.Enabled = dismissed || HasRequiredBinding();
            laterButton.Enabled = true;
            saveButton.Text = "Salvar avaliação";
            MessageBox.Show(this, ex.Message, "Relato AI", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task SaveAsync(bool dismissed)
    {
        if (config is null) throw new InvalidOperationException("Desktop Agent não pareado");
        var selectedTags = tags.CheckedItems.Cast<object>()
            .Select(x => x?.ToString() ?? "")
            .Where(x => x.Length > 0)
            .ToArray();
        var relation = direction.SelectedItem?.ToString() switch
        {
            "Melhorou" => "IMPROVING",
            "Piorou" => "WORSENING",
            _ => "STABLE"
        };
        if (!dismissed && !HasRequiredBinding())
            throw new InvalidOperationException("Selecione um cliente, marque como prospect comercial ou escolha 'Sem vínculo'.");
        var selected = clientBinding.SelectedItem as BindingOption;
        var manual = feedbackContext?.RequiresSelection == true;
        var sdrWorkflow = string.Equals(feedbackContext?.Workflow, "SDR_PROSPECT", StringComparison.OrdinalIgnoreCase);
        var autoSdrProspect = sdrWorkflow && selected?.NoClient != true;
        var isProspect = autoSdrProspect || (manual && selected?.Prospect == true);
        var clientId = isProspect ? null : manual ? selected?.Id : feedbackContext?.ClientId;
        var noClient = !isProspect && (manual ? selected?.NoClient == true : string.IsNullOrWhiteSpace(feedbackContext?.ClientId));
        var prospect = isProspect ? new
        {
            name = prospectName.Text.Trim(),
            company = prospectCompany.Text.Trim(),
            email = prospectEmail.Text.Trim(),
            phone = prospectPhone.Text.Trim(),
            city = prospectCity.Text.Trim(),
            instagram = prospectInstagram.Text.Trim(),
            marketing_investment = prospectMarketing.Text.Trim(),
            broker_count = (int)prospectBrokers.Value,
            pain_points = SplitEntries(prospectPain.Text),
            goals = SplitEntries(prospectGoals.Text),
            services_interest = SplitEntries(prospectInterest.Text),
            objections = SplitEntries(prospectObjections.Text),
            urgency = prospectUrgency.Text.Trim(),
            decision_role = prospectDecisionRole.Text.Trim(),
            current_structure = prospectStructure.Text.Trim(),
            buying_signals = SplitEntries(prospectBuyingSignals.Text),
            closing_risks = SplitEntries(prospectClosingRisks.Text),
            closer_briefing = prospectBriefing.Text.Trim(),
            next_step = prospectNextStep.Text.Trim(),
            next_step_at = prospectNextStepAt.Checked ? prospectNextStepAt.Value.ToUniversalTime().ToString("O") : null
        } : null;
        var feedback = new
        {
            channel = interactionChannel,
            client_id = clientId,
            no_client = noClient,
            is_prospect = isProspect,
            prospect,
            binding_source = isProspect ? "RELATO_COMMERCIAL" : manual ? "MANUAL" : "AUTO",
            mood = mood.SelectedItem?.ToString(),
            tone = tone.SelectedItem?.ToString(),
            receptivity = (int)receptivity.Value,
            trust_level = (int)trust.Value,
            perceived_risk = (int)risk.Value,
            relationship_direction = relation,
            tags = selectedTags,
            note = note.Text.Trim(),
            dismissed
        };
        var api = new RelatoApi(config);
        Exception? last = null;
        for (var attempt = 1; attempt <= 8; attempt++)
        {
            try
            {
                await api.SaveFeedbackAsync(sessionId, feedback);
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                if (attempt < 8) await Task.Delay(500);
            }
        }
        throw last ?? new InvalidOperationException("Não foi possível salvar a avaliação.");
    }
}

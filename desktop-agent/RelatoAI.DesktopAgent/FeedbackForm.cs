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
    private readonly Button crmConfirmButton = new();
    private readonly Button crmDifferentButton = new();
    private bool crmMatchDecisionRequired;
    private bool crmMatchRejected;
    private string? matchedCrmLeadId;
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

    private static readonly HashSet<string> CsPeople = new(StringComparer.OrdinalIgnoreCase) { "Gustavo Lima", "Joel Antoniete" };
    private static readonly HashSet<string> GtPeople = new(StringComparer.OrdinalIgnoreCase) { "Breno Oliveira", "Danilo Oliveira Santos", "Felipe Oliveira", "João Margiotta", "Rodrigo Cavalheiro", "Yuri Melo" };
    private readonly TextBox opsSummary = MultiInput(532, 82);
    private readonly TextBox opsProblems = MultiInput(532, 70);
    private readonly TextBox opsResponsible = Input(246);
    private readonly DateTimePicker opsDeadline = DatePicker(246);
    private readonly TextBox opsNextStep = Input(532);
    private readonly ComboBox csHealth = SelectBox(246);
    private readonly CheckBox csChurnRisk = new() { Text = "Risco de churn", AutoSize = true, ForeColor = TextMain, BackColor = Panel };
    private readonly TextBox csRiskReason = MultiInput(532, 58);
    private readonly TextBox csAgencyCommitments = MultiInput(532, 70);
    private readonly TextBox csClientCommitments = MultiInput(532, 70);
    private readonly DateTimePicker csNextContact = DatePicker(246);
    private readonly TextBox gtProduct = Input(246);
    private readonly TextBox gtCampaign = Input(246);
    private readonly TextBox gtBudgetChange = Input(532);
    private readonly TextBox gtAudienceRegion = Input(532);
    private readonly TextBox gtCreative = Input(532);
    private readonly TextBox gtPerformanceIssue = MultiInput(532, 62);
    private readonly TextBox gtDecisions = MultiInput(532, 70);
    private readonly TextBox gtActions = MultiInput(532, 70);

    private FeedbackContext? feedbackContext;
    private bool contextReady;
    private bool submitted;
    private bool IsGustavoSdr => string.Equals(config?.OwnerPerson?.Trim(), "Gustavo Royce", StringComparison.OrdinalIgnoreCase);
    private bool IsCsOperator => config?.OwnerPerson is { } owner && CsPeople.Contains(owner.Trim());
    private bool IsGtOperator => config?.OwnerPerson is { } owner && GtPeople.Contains(owner.Trim());
    private bool IsOpsRole => IsCsOperator || IsGtOperator;

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
        csHealth.Items.AddRange(["Não definido", "Verde", "Amarelo", "Vermelho"]);
        mood.SelectedIndex = 2;
        tone.SelectedIndex = 2;
        direction.SelectedIndex = 1;
        csHealth.SelectedIndex = 0;
        opsSummary.PlaceholderText = "Resumo objetivo da conversa";
        opsProblems.PlaceholderText = "Separe por ;";
        opsResponsible.PlaceholderText = "Quem ficou responsável";
        opsNextStep.PlaceholderText = "Próximo passo";
        csRiskReason.PlaceholderText = "Por que existe risco / atenção";
        csAgencyCommitments.PlaceholderText = "O que a agência ficou de fazer · separe por ;";
        csClientCommitments.PlaceholderText = "O que o cliente ficou de fazer · separe por ;";
        gtProduct.PlaceholderText = "Produto / empreendimento";
        gtCampaign.PlaceholderText = "Campanha / conjunto / anúncio";
        gtBudgetChange.PlaceholderText = "Ex.: R$ 100/dia → R$ 150/dia";
        gtAudienceRegion.PlaceholderText = "Público, cidade, região ou segmentação";
        gtCreative.PlaceholderText = "Criativo / oferta / CTA mencionado";
        gtPerformanceIssue.PlaceholderText = "Problema de performance, lead, CPL, CTR, saldo...";
        gtDecisions.PlaceholderText = "Decisões tomadas · separe por ;";
        gtActions.PlaceholderText = "Ações que precisam ser executadas · separe por ;";
        BuildUi();
        prospectCard.Visible = IsGustavoSdr;
        contextReady = IsGustavoSdr;
        if (IsGustavoSdr)
        {
            contactStatus.Text = "Pós-call pronto";
            contactStatus.ForeColor = Accent;
            contactDetail.Text = "Preencha o nome. O telefone está sendo identificado automaticamente em segundo plano.";
        }
        saveButton.Enabled = false;
        clientBinding.SelectedIndexChanged += (_, _) =>
        {
            var option = clientBinding.SelectedItem as BindingOption;
            prospectCard.Visible = option?.Prospect == true;
            if (option?.Prospect == true)
            {
                if (!IsGustavoSdr && string.IsNullOrWhiteSpace(prospectName.Text)) prospectName.Text = feedbackContext?.RemoteName ?? "";
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
        var titleText = IsGustavoSdr ? "Registrar prospect"
            : IsCsOperator ? "Registrar acompanhamento do cliente"
            : IsGtOperator ? "Registrar decisões de tráfego"
            : "Como essa call terminou?";
        var subtitleText = IsGustavoSdr
            ? "Digite o nome manualmente e confirme só o essencial. O Relato completa o CRM Awave com a transcrição."
            : IsCsOperator
                ? "O Relato organiza saúde, risco, compromissos e próximos passos do cliente."
                : IsGtOperator
                    ? "O Relato transforma a conversa em decisões, alterações de campanha e ações executáveis."
                    : "Sua leitura humana complementa a transcrição e ajuda a detectar risco, confiança e próximos passos.";
        var title = new Label { Text = titleText, ForeColor = TextMain, Font = new Font(Font.FontFamily, 18F, FontStyle.Bold), AutoSize = true, Location = new Point(28, 43) };
        var sub = new Label { Text = subtitleText, ForeColor = Muted, Font = new Font(Font.FontFamily, 9.5F), AutoSize = true, MaximumSize = new Size(570, 40), Location = new Point(30, 78) };
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
        if (IsGustavoSdr)
        {
            body.Controls.Add(BuildGustavoProspectCard());
            return body;
        }
        if (IsCsOperator)
        {
            body.Controls.Add(BuildCsOpsCard());
            return body;
        }
        if (IsGtOperator)
        {
            body.Controls.Add(BuildGtOpsCard());
            return body;
        }
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

        crmConfirmButton.Text = "Sim, é ele";
        crmConfirmButton.SetBounds(18, 88, 150, 38);
        StylePrimaryButton(crmConfirmButton);
        crmConfirmButton.Visible = false;
        crmConfirmButton.Click += (_, _) =>
        {
            crmMatchRejected = false;
            crmMatchDecisionRequired = false;
            crmConfirmButton.Visible = false;
            crmDifferentButton.Visible = false;
            contactStatus.Text = "Prospect do Awave confirmado";
            contactDetail.Text = "Dados carregados. Complete apenas o que mudou na ligação e salve.";
            saveButton.Enabled = CanSaveNow();
        };

        crmDifferentButton.Text = "Não é ele · preencher do zero";
        crmDifferentButton.SetBounds(180, 88, 180, 38);
        StyleSecondaryButton(crmDifferentButton);
        crmDifferentButton.Visible = false;
        crmDifferentButton.Click += (_, _) =>
        {
            crmMatchDecisionRequired = false;
            crmConfirmButton.Visible = false;
            crmDifferentButton.Visible = false;
            crmMatchRejected = true;
            matchedCrmLeadId = null;
            prospectName.Clear();
            prospectCompany.Clear();
            prospectEmail.Clear();
            prospectPhone.Clear();
            prospectCity.Clear();
            prospectInstagram.Clear();
            prospectMarketing.Clear();
            prospectPain.Clear();
            prospectGoals.Clear();
            prospectInterest.Clear();
            prospectObjections.Clear();
            prospectUrgency.Clear();
            prospectDecisionRole.Clear();
            prospectStructure.Clear();
            prospectBuyingSignals.Clear();
            prospectClosingRisks.Clear();
            prospectBriefing.Clear();
            prospectNextStep.Clear();
            prospectNextStepAt.Checked = false;
            contactStatus.Text = "Cadastrar outro prospect";
            contactDetail.Text = "Preencha os dados do zero. O vínculo encontrado no Awave foi descartado.";
            prospectName.Focus();
            saveButton.Enabled = CanSaveNow();
        };

        card.Controls.Add(contactStatus);
        card.Controls.Add(contactDetail);
        card.Controls.Add(clientBinding);
        card.Controls.Add(crmConfirmButton);
        card.Controls.Add(crmDifferentButton);
        return card;
    }

    private Control BuildGustavoProspectCard()
    {
        prospectCard.Height = 470;
        prospectCard.Margin = new Padding(0, 0, 0, 16);
        prospectCard.Controls.Clear();
        prospectCard.Controls.Add(new Label { Text = "PROSPECT COMERCIAL", ForeColor = Accent, Font = new Font(Font.FontFamily, 9F, FontStyle.Bold), AutoSize = true, Location = new Point(18, 14) });
        prospectCard.Controls.Add(new Label { Text = "Nome é obrigatório. Os demais dados podem ser corrigidos/completados aqui.", ForeColor = Muted, AutoSize = true, Location = new Point(18, 38) });

        prospectName.PlaceholderText = "Digite o nome do contato";
        prospectCompany.PlaceholderText = "Empresa / imobiliária";
        prospectPhone.PlaceholderText = "Telefone";
        prospectEmail.PlaceholderText = "E-mail";
        prospectCity.PlaceholderText = "Cidade / região";
        prospectNextStep.PlaceholderText = "Ex.: enviar proposta, agendar reunião...";

        AddProspectField("Nome do contato *", prospectName, 18, 70);
        AddProspectField("Empresa / imobiliária", prospectCompany, 306, 70);
        AddProspectField("Telefone", prospectPhone, 18, 126);
        AddProspectField("E-mail", prospectEmail, 306, 126);
        AddProspectField("Cidade / região", prospectCity, 18, 182);
        AddProspectField("Próximo passo", prospectNextStep, 18, 238);
        AddProspectField("Data do próximo passo", prospectNextStepAt, 18, 294);

        note.SetBounds(18, 371, 532, 72);
        note.Multiline = true;
        note.ScrollBars = ScrollBars.Vertical;
        note.BackColor = Panel2;
        note.ForeColor = TextMain;
        note.BorderStyle = BorderStyle.FixedSingle;
        note.PlaceholderText = "Observação curta, só se houver algo importante.";
        prospectCard.Controls.Add(new Label { Text = "Observação rápida", ForeColor = Muted, AutoSize = true, Location = new Point(18, 350) });
        prospectCard.Controls.Add(note);
        return prospectCard;
    }

    private Control BuildCsOpsCard()
    {
        var card = Card(570, 850);
        card.Margin = new Padding(0, 0, 0, 16);
        card.Controls.Add(new Label { Text = "CS · ACOMPANHAMENTO DO CLIENTE", ForeColor = Accent, Font = new Font(Font.FontFamily, 9F, FontStyle.Bold), AutoSize = true, Location = new Point(18, 14) });
        card.Controls.Add(new Label { Text = "Revise o que a transcrição preencheu e ajuste só o que precisar.", ForeColor = Muted, AutoSize = true, Location = new Point(18, 38) });

        AddOpsField(card, "Resumo da conversa", opsSummary, 70);
        card.Controls.Add(new Label { Text = "Saúde após a call", ForeColor = Muted, AutoSize = true, Location = new Point(18, 182) });
        csHealth.Location = new Point(18, 202);
        card.Controls.Add(csHealth);
        csChurnRisk.Location = new Point(306, 207);
        card.Controls.Add(csChurnRisk);
        AddOpsField(card, "Motivo de risco / atenção", csRiskReason, 246);
        AddOpsField(card, "Problemas e pendências · separe por ;", opsProblems, 334);
        AddOpsField(card, "A agência ficou de · separe por ;", csAgencyCommitments, 434);
        AddOpsField(card, "O cliente ficou de · separe por ;", csClientCommitments, 534);

        card.Controls.Add(new Label { Text = "Responsável", ForeColor = Muted, AutoSize = true, Location = new Point(18, 634) });
        opsResponsible.Location = new Point(18, 653); card.Controls.Add(opsResponsible);
        card.Controls.Add(new Label { Text = "Prazo", ForeColor = Muted, AutoSize = true, Location = new Point(306, 634) });
        opsDeadline.Location = new Point(306, 653); card.Controls.Add(opsDeadline);
        card.Controls.Add(new Label { Text = "Próximo contato", ForeColor = Muted, AutoSize = true, Location = new Point(18, 700) });
        csNextContact.Location = new Point(18, 719); card.Controls.Add(csNextContact);
        AddOpsField(card, "Próximo passo", opsNextStep, 764);
        return card;
    }

    private Control BuildGtOpsCard()
    {
        var card = Card(570, 1010);
        card.Margin = new Padding(0, 0, 0, 16);
        card.Controls.Add(new Label { Text = "GT · DECISÕES DE TRÁFEGO", ForeColor = Accent, Font = new Font(Font.FontFamily, 9F, FontStyle.Bold), AutoSize = true, Location = new Point(18, 14) });
        card.Controls.Add(new Label { Text = "Consolide produto, campanha, alteração e execução sem reescrever a reunião.", ForeColor = Muted, AutoSize = true, Location = new Point(18, 38) });

        AddOpsField(card, "Resumo da conversa", opsSummary, 70);
        card.Controls.Add(new Label { Text = "Produto / empreendimento", ForeColor = Muted, AutoSize = true, Location = new Point(18, 182) });
        gtProduct.Location = new Point(18, 201); card.Controls.Add(gtProduct);
        card.Controls.Add(new Label { Text = "Campanha / anúncio", ForeColor = Muted, AutoSize = true, Location = new Point(306, 182) });
        gtCampaign.Location = new Point(306, 201); card.Controls.Add(gtCampaign);
        AddOpsField(card, "Alteração de orçamento", gtBudgetChange, 246);
        AddOpsField(card, "Público / região / segmentação", gtAudienceRegion, 302);
        AddOpsField(card, "Criativo / oferta / CTA", gtCreative, 358);
        AddOpsField(card, "Problema de performance / leads", gtPerformanceIssue, 414);
        AddOpsField(card, "Decisões tomadas · separe por ;", gtDecisions, 506);
        AddOpsField(card, "Ações a executar · separe por ;", gtActions, 606);

        card.Controls.Add(new Label { Text = "Responsável", ForeColor = Muted, AutoSize = true, Location = new Point(18, 706) });
        opsResponsible.Location = new Point(18, 725); card.Controls.Add(opsResponsible);
        card.Controls.Add(new Label { Text = "Prazo", ForeColor = Muted, AutoSize = true, Location = new Point(306, 706) });
        opsDeadline.Location = new Point(306, 725); card.Controls.Add(opsDeadline);
        AddOpsField(card, "Próximo passo", opsNextStep, 774);
        AddOpsField(card, "Outros problemas / observações · separe por ;", opsProblems, 830);
        return card;
    }

    private static void AddOpsField(Panel card, string label, TextBox box, int y)
    {
        card.Controls.Add(new Label { Text = label, ForeColor = Muted, AutoSize = true, Location = new Point(18, y) });
        box.Location = new Point(18, y + 19);
        card.Controls.Add(box);
    }

    private Control BuildProspectCard()
    {
        prospectCard.Height = 1040;
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
        saveButton.Text = IsGustavoSdr ? "Salvar no CRM" : IsOpsRole ? "Salvar operação" : "Salvar avaliação";
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

    private static TextBox MultiInput(int width, int height) => new()
    {
        Width = width,
        Height = height,
        Multiline = true,
        ScrollBars = ScrollBars.Vertical,
        BackColor = Panel2,
        ForeColor = TextMain,
        BorderStyle = BorderStyle.FixedSingle
    };

    private static DateTimePicker DatePicker(int width) => new()
    {
        Width = width,
        ShowCheckBox = true,
        Checked = false,
        Format = DateTimePickerFormat.Custom,
        CustomFormat = "dd/MM/yyyy HH:mm",
        CalendarMonthBackground = Panel2
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
                if ((string.Equals(context.Workflow, "OPS_CS", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(context.Workflow, "OPS_GT", StringComparison.OrdinalIgnoreCase))
                    && !context.TranscriptReady)
                    _ = RefreshOpsSuggestionsAsync(api);
                return;
            }
            catch (Exception ex)
            {
                last = ex;
                await Task.Delay(300);
            }
        }
        if (IsGustavoSdr)
        {
            contactStatus.Text = "Pós-call pronto";
            contactStatus.ForeColor = Accent;
            contactDetail.Text = "Você pode salvar normalmente. Se o telefone for identificado, ele entra automaticamente no campo.";
            return;
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
                ApplyProspectPrefill(context.ProspectPrefill, includeName: !IsGustavoSdr);
                if (!IsGustavoSdr && !string.IsNullOrWhiteSpace(context.RemoteName) && string.IsNullOrWhiteSpace(prospectName.Text))
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

    private void ApplyProspectPrefill(ProspectPrefill? value, bool includeName = true)
    {
        if (value is null) return;
        void Fill(TextBox box, string? text) { if (string.IsNullOrWhiteSpace(box.Text) && !string.IsNullOrWhiteSpace(text)) box.Text = text; }
        if (includeName) Fill(prospectName, value.Name);
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

    private void ApplyOpsPrefill(OpsPrefill? value)
    {
        if (value is null) return;
        void Fill(TextBox box, string? text)
        {
            if (string.IsNullOrWhiteSpace(box.Text) && !string.IsNullOrWhiteSpace(text)) box.Text = text;
        }
        Fill(opsSummary, value.Summary);
        Fill(opsProblems, string.Join("; ", value.Problems));
        Fill(opsNextStep, value.NextStep);
        if (IsCsOperator)
        {
            Fill(csAgencyCommitments, string.Join("; ", value.Commitments));
            if (csHealth.SelectedIndex == 0 && !string.IsNullOrWhiteSpace(value.Health))
            {
                csHealth.SelectedItem = value.Health.ToUpperInvariant() switch
                {
                    "GREEN" => "Verde",
                    "YELLOW" => "Amarelo",
                    "RED" => "Vermelho",
                    _ => "Não definido"
                };
            }
            if (value.ChurnRisk) csChurnRisk.Checked = true;
        }
        if (IsGtOperator)
        {
            Fill(gtDecisions, string.Join("; ", value.Decisions));
            Fill(gtActions, string.Join("; ", value.ActionItems));
        }
    }

    private async Task RefreshOpsSuggestionsAsync(RelatoApi api)
    {
        for (var attempt = 0; attempt < 45 && !IsDisposed; attempt++)
        {
            await Task.Delay(1000);
            try
            {
                var context = await api.GetFeedbackContextAsync(sessionId);
                if (context.Pending) continue;
                if (!string.Equals(context.Workflow, "OPS_CS", StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(context.Workflow, "OPS_GT", StringComparison.OrdinalIgnoreCase)) return;
                feedbackContext = context;
                ApplyOpsPrefill(context.OpsPrefill);
                if (context.TranscriptReady) return;
            }
            catch { }
        }
    }

    private void ApplyContext(FeedbackContext context)
    {
        ApplyProspectPrefill(context.ProspectPrefill, includeName: !IsGustavoSdr);
        ApplyOpsPrefill(context.OpsPrefill);
        var phone = string.IsNullOrWhiteSpace(context.RemotePhone) ? null : $"+{context.RemotePhone}";
        var person = string.IsNullOrWhiteSpace(context.RemoteName) ? phone ?? "Contato não identificado" : context.RemoteName;
        var identity = string.Join(" · ", new[] { person, phone }.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct());

        if (string.Equals(context.Workflow, "SDR_PROSPECT", StringComparison.OrdinalIgnoreCase))
        {
            contactStatus.Text = "Prospect comercial · SDR";
            contactStatus.ForeColor = Accent;
            if (IsGustavoSdr && context.CrmMatch is not null)
            {
                crmMatchRejected = false;
                crmMatchDecisionRequired = true;
                var match = context.CrmMatch;
                matchedCrmLeadId = string.IsNullOrWhiteSpace(match.Id) ? null : match.Id;
                if (string.IsNullOrWhiteSpace(prospectName.Text) && !string.IsNullOrWhiteSpace(match.Name)) prospectName.Text = match.Name;
                if (string.IsNullOrWhiteSpace(prospectCompany.Text) && !string.IsNullOrWhiteSpace(match.Company)) prospectCompany.Text = match.Company;
                if (string.IsNullOrWhiteSpace(prospectEmail.Text) && !string.IsNullOrWhiteSpace(match.Email)) prospectEmail.Text = match.Email;
                if (string.IsNullOrWhiteSpace(prospectPhone.Text) && !string.IsNullOrWhiteSpace(match.Phone)) prospectPhone.Text = "+" + match.Phone;
                var matchPhone = phone ?? (string.IsNullOrWhiteSpace(match.Phone) ? null : "+" + match.Phone);
                var funnel = string.Join(" · ", new[] { match.Pipeline, match.Stage }
                    .Where(x => !string.IsNullOrWhiteSpace(x)));
                var label = string.Join(" · ", new[] { match.Name, match.Company, matchPhone }
                    .Where(x => !string.IsNullOrWhiteSpace(x)));
                contactStatus.Text = "Já existe um prospect com este número no Awave";
                contactDetail.Text = label + (string.IsNullOrWhiteSpace(funnel) ? "" : "\n" + funnel) + "\nÉ esta pessoa?";
                crmConfirmButton.Visible = true;
                crmDifferentButton.Visible = true;
            }
            else
            {
                crmMatchDecisionRequired = false;
                crmConfirmButton.Visible = false;
                crmDifferentButton.Visible = false;
                contactDetail.Text = IsGustavoSdr
                    ? $"{(phone ?? "Telefone não identificado")}\nNão encontrei esse número no Awave. Preencha os dados para criar um novo prospect."
                    : string.IsNullOrWhiteSpace(context.RemoteName)
                        ? $"{identity}\nO Relato vai completar os dados disponíveis enquanto a transcrição processa."
                        : $"{identity}\nProspect selecionado automaticamente pelo perfil SDR.";
            }
            clientBinding.Items.Clear();
            clientBinding.Items.Add(new BindingOption(null, "Prospect comercial / possível cliente", false, true));
            clientBinding.Items.Add(new BindingOption(null, "Sem vínculo com cliente ou prospect", true));
            clientBinding.SelectedIndex = 0;
            clientBinding.Visible = !IsGustavoSdr;
            prospectCard.Visible = true;
            if (!IsGustavoSdr && string.IsNullOrWhiteSpace(prospectName.Text) && !string.IsNullOrWhiteSpace(context.RemoteName))
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
        if (!IsOpsRole)
            clientBinding.Items.Add(new BindingOption(null, "Prospect comercial / possível cliente", false, true));
        clientBinding.Items.Add(new BindingOption(null, IsOpsRole ? "Sem vínculo / conversa interna" : "Sem vínculo com cliente ou prospect", true));
        clientBinding.SelectedIndex = 0;
        clientBinding.Visible = true;
        saveButton.Enabled = false;
    }

    private bool HasRequiredBinding()
    {
        if (!contextReady) return false;
        if (IsGustavoSdr) return !crmMatchDecisionRequired && !string.IsNullOrWhiteSpace(prospectName.Text);
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
        // O pós-call é humano e precisa poder ser salvo assim que a ligação termina.
        // Whisper/IA continuam em segundo plano e fazem merge depois sem bloquear o SDR.
        return HasRequiredBinding();
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
            saveButton.Text = IsGustavoSdr ? "Salvar no CRM" : IsOpsRole ? "Salvar operação" : "Salvar avaliação";
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
        if (!dismissed && IsGustavoSdr && string.IsNullOrWhiteSpace(prospectName.Text))
            throw new InvalidOperationException("Informe o nome do contato antes de salvar no CRM.");
        if (!dismissed && !HasRequiredBinding())
            throw new InvalidOperationException(IsOpsRole
                ? "Selecione o cliente desta conversa ou escolha 'Sem vínculo / conversa interna'."
                : "Selecione um cliente, marque como prospect comercial ou escolha 'Sem vínculo'.");
        if (!dismissed && IsCsOperator && csChurnRisk.Checked && string.IsNullOrWhiteSpace(csRiskReason.Text))
            throw new InvalidOperationException("Descreva rapidamente o motivo do risco de churn.");
        var selected = clientBinding.SelectedItem as BindingOption;
        var manual = feedbackContext?.RequiresSelection == true;
        var sdrWorkflow = IsGustavoSdr || string.Equals(feedbackContext?.Workflow, "SDR_PROSPECT", StringComparison.OrdinalIgnoreCase);
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
        var healthCode = csHealth.SelectedItem?.ToString() switch
        {
            "Verde" => "GREEN",
            "Amarelo" => "YELLOW",
            "Vermelho" => "RED",
            _ => "UNKNOWN"
        };
        object? operational = null;
        if (IsCsOperator)
        {
            operational = new
            {
                summary = opsSummary.Text.Trim(),
                health = healthCode,
                churn_risk = csChurnRisk.Checked,
                risk_reason = csRiskReason.Text.Trim(),
                problems = SplitEntries(opsProblems.Text),
                agency_commitments = SplitEntries(csAgencyCommitments.Text),
                client_commitments = SplitEntries(csClientCommitments.Text),
                responsible = opsResponsible.Text.Trim(),
                deadline = opsDeadline.Checked ? opsDeadline.Value.ToUniversalTime().ToString("O") : null,
                next_contact = csNextContact.Checked ? csNextContact.Value.ToUniversalTime().ToString("O") : null,
                next_step = opsNextStep.Text.Trim()
            };
        }
        else if (IsGtOperator)
        {
            operational = new
            {
                summary = opsSummary.Text.Trim(),
                product = gtProduct.Text.Trim(),
                campaign = gtCampaign.Text.Trim(),
                budget_change = gtBudgetChange.Text.Trim(),
                audience_region = gtAudienceRegion.Text.Trim(),
                creative = gtCreative.Text.Trim(),
                performance_issue = gtPerformanceIssue.Text.Trim(),
                decisions = SplitEntries(gtDecisions.Text),
                action_items = SplitEntries(gtActions.Text),
                responsible = opsResponsible.Text.Trim(),
                deadline = opsDeadline.Checked ? opsDeadline.Value.ToUniversalTime().ToString("O") : null,
                next_step = opsNextStep.Text.Trim(),
                problems = SplitEntries(opsProblems.Text)
            };
        }

        var feedback = new
        {
            channel = interactionChannel,
            client_id = clientId,
            no_client = noClient,
            is_prospect = isProspect,
            prospect,
            binding_source = isProspect ? "RELATO_COMMERCIAL" : manual ? "MANUAL" : "AUTO",
            crm_lead_id = matchedCrmLeadId,
            crm_match_rejected = crmMatchRejected,
            operational,
            mood = (IsGustavoSdr || IsOpsRole) ? null : mood.SelectedItem?.ToString(),
            tone = (IsGustavoSdr || IsOpsRole) ? null : tone.SelectedItem?.ToString(),
            receptivity = (IsGustavoSdr || IsOpsRole) ? (int?)null : (int)receptivity.Value,
            trust_level = (IsGustavoSdr || IsOpsRole) ? (int?)null : (int)trust.Value,
            perceived_risk = (IsGustavoSdr || IsOpsRole) ? (int?)null : (int)risk.Value,
            relationship_direction = (IsGustavoSdr || IsOpsRole) ? "UNKNOWN" : relation,
            tags = (IsGustavoSdr || IsOpsRole) ? Array.Empty<string>() : selectedTags,
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

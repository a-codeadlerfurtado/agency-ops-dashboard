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
    private bool submitted;

    public FeedbackForm(AgentConfig? config, string sessionId)
    {
        this.config = config;
        this.sessionId = sessionId;
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
        Shown += (_, _) => { Activate(); BringToFront(); };
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
        var title = new Label { Text = "Como o cliente saiu dessa call?", ForeColor = TextMain, Font = new Font(Font.FontFamily, 18F, FontStyle.Bold), AutoSize = true, Location = new Point(28, 43) };
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

        body.Controls.Add(SectionTitle("Leitura do cliente", "Percepção geral da conversa"));
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
            saveButton.Enabled = true;
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
        var feedback = new
        {
            channel = "WHATSAPP_DESKTOP",
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

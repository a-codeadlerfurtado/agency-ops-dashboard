namespace RelatoAI.DesktopAgent;

internal sealed class FeedbackForm : Form
{
    private readonly AgentConfig? config;
    private readonly string sessionId;
    private readonly ComboBox mood = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 170 };
    private readonly ComboBox tone = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 170 };
    private readonly ComboBox direction = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 170 };
    private readonly NumericUpDown receptivity = Score();
    private readonly NumericUpDown trust = Score();
    private readonly NumericUpDown risk = Score();
    private readonly CheckedListBox tags = new() { Width = 360, Height = 72, CheckOnClick = true };
    private readonly TextBox note = new() { Multiline = true, Width = 360, Height = 70, ScrollBars = ScrollBars.Vertical };

    public FeedbackForm(AgentConfig? config, string sessionId)
    {
        this.config = config; this.sessionId = sessionId;
        Text = "Relato AI — Percepção humana";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false; ClientSize = new Size(430, 540);
        mood.Items.AddRange(["Ótimo", "Bom", "Neutro", "Preocupado", "Irritado"]);
        tone.Items.AddRange(["Animado", "Receptivo", "Neutro", "Frio", "Defensivo", "Impaciente"]);
        direction.Items.AddRange(["Melhorou", "Igual", "Piorou"]);
        mood.SelectedIndex = 2; tone.SelectedIndex = 2; direction.SelectedIndex = 1;
        tags.Items.AddRange(["Abertura", "Confiança", "Urgência", "Dúvida", "Objeção", "Resistência", "Frustração", "Risco"]);
        BuildUi();
    }
    private void BuildUi()
    {
        var panel = new FlowLayoutPanel { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(22), AutoScroll = true };
        panel.Controls.Add(new Label { Text = "Como estava o cliente nessa call?", AutoSize = true, Font = new Font(Font.FontFamily, 12, FontStyle.Bold) });
        panel.Controls.Add(new Label { Text = "Humor", AutoSize = true, Margin = new Padding(0, 14, 0, 3) }); panel.Controls.Add(mood);
        panel.Controls.Add(new Label { Text = "Tom de voz", AutoSize = true, Margin = new Padding(0, 12, 0, 3) }); panel.Controls.Add(tone);
        panel.Controls.Add(Row("Receptividade", receptivity));
        panel.Controls.Add(Row("Confiança", trust));
        panel.Controls.Add(Row("Risco percebido", risk));
        panel.Controls.Add(new Label { Text = "Relação após a call", AutoSize = true, Margin = new Padding(0, 12, 0, 3) }); panel.Controls.Add(direction);
        panel.Controls.Add(new Label { Text = "Sinais percebidos · opcional", AutoSize = true, Margin = new Padding(0, 12, 0, 3) }); panel.Controls.Add(tags);
        panel.Controls.Add(new Label { Text = "Nota rápida · opcional", AutoSize = true, Margin = new Padding(0, 12, 0, 3) });
        note.PlaceholderText = "Algo que só quem participou percebeu?"; panel.Controls.Add(note);
        var actions = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(0, 14, 0, 0) };
        var later = new Button { Text = "Agora não", Width = 100 }; var save = new Button { Text = "Salvar avaliação", Width = 130 };
        later.Click += async (_, _) => { await SaveAsync(true); Close(); };
        save.Click += async (_, _) => { await SaveAsync(false); Close(); };
        actions.Controls.Add(later); actions.Controls.Add(save); panel.Controls.Add(actions);
        Controls.Add(panel);
    }

    private static NumericUpDown Score() => new() { Minimum = 1, Maximum = 5, Value = 3, Width = 60 };
    private static Control Row(string label, Control control)
    {
        var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(0, 10, 0, 0) };
        row.Controls.Add(new Label { Text = label, Width = 180, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(0, 5, 0, 0) });
        row.Controls.Add(control);
        return row;
    }

    private async Task SaveAsync(bool dismissed)
    {
        if (config is null) return;
        var selectedTags = tags.CheckedItems.Cast<object>().Select(x => x?.ToString() ?? "").Where(x => x.Length > 0).ToArray();
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
        try { await new RelatoApi(config).SaveFeedbackAsync(sessionId, feedback); }
        catch (Exception ex)
        {
            if (!dismissed) MessageBox.Show(this, ex.Message, "Relato AI", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }
}

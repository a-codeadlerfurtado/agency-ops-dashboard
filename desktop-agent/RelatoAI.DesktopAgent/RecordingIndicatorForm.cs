namespace RelatoAI.DesktopAgent;

internal sealed class RecordingIndicatorForm : Form
{
    private readonly Label sourceLabel;

    public RecordingIndicatorForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(11, 22, 43);
        ForeColor = Color.FromArgb(243, 247, 255);
        ClientSize = new Size(310, 58);
        Padding = new Padding(14, 8, 14, 8);

        var dot = new Label
        {
            AutoSize = true,
            Text = "●",
            ForeColor = Color.FromArgb(239, 68, 68),
            Font = new Font("Segoe UI", 14f, FontStyle.Bold),
            Location = new Point(14, 11),
        };
        var title = new Label
        {
            AutoSize = true,
            Text = "Relato AI · Gravando e transcrevendo",
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            Location = new Point(38, 10),
        };
        sourceLabel = new Label
        {
            AutoSize = true,
            Text = "WhatsApp Desktop",
            ForeColor = Color.FromArgb(151, 169, 202),
            Font = new Font("Segoe UI", 8.5f, FontStyle.Regular),
            Location = new Point(40, 31),
        };
        Controls.Add(dot);
        Controls.Add(title);
        Controls.Add(sourceLabel);
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            const int WS_EX_TOOLWINDOW = 0x00000080;
            const int WS_EX_NOACTIVATE = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    public void ShowIndicator(string source)
    {
        sourceLabel.Text = source;
        var area = Screen.PrimaryScreen?.WorkingArea ?? Screen.GetWorkingArea(Cursor.Position);
        Location = new Point(area.Right - Width - 18, area.Top + 18);
        if (!Visible) Show();
        else BringToFront();
    }

    public void HideIndicator()
    {
        if (Visible) Hide();
    }
}

namespace RelatoAI.DesktopAgent;

internal sealed class PairingForm : Form
{
    private readonly TextBox code = new() { Width = 220, CharacterCasing = CharacterCasing.Upper };
    private readonly Label status = new() { AutoSize = true, ForeColor = Color.DimGray };
    public string PairingCode => code.Text.Trim();

    public PairingForm()
    {
        Text = "Relato AI — Parear Desktop Agent";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = false; ClientSize = new Size(390, 175);
        var title = new Label { Text = "Código de conexão", Font = new Font(Font, FontStyle.Bold), AutoSize = true, Left = 24, Top = 22 };
        code.Left = 24; code.Top = 52;
        var hint = new Label { Text = "Use o código gerado em Relato AI → Workspace → Conectar captura.", AutoSize = true, Left = 24, Top = 87 };
        var ok = new Button { Text = "Parear", DialogResult = DialogResult.OK, Left = 280, Top = 123, Width = 82 };
        status.Left = 24; status.Top = 130;
        Controls.AddRange([title, code, hint, status, ok]);
        AcceptButton = ok;
    }
}
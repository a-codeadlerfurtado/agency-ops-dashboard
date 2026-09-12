namespace RelatoAI.DesktopAgent;

internal static class Program
{
    private static Mutex? instanceMutex;

    [STAThread]
    static void Main()
    {
        instanceMutex = new Mutex(true, "Local\\RelatoAI.DesktopAgent", out var createdNew);
        if (!createdNew)
        {
            MessageBox.Show("O Relato AI já está em execução na bandeja do Windows.", "Relato AI",
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            instanceMutex.Dispose();
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new AgentContext());
        instanceMutex.Dispose();
    }
}

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RelatoAI.DesktopAgent;

internal sealed record AgentConfig(
    string DeviceId,
    string OwnerPerson,
    string ProtectedToken,
    bool Enabled = true,
    string? LocalPhone = null)
{
    private static readonly string Dir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RelatoAI");
    private static readonly string FilePath = Path.Combine(Dir, "desktop-agent.json");

    public string Token => Encoding.UTF8.GetString(
        ProtectedData.Unprotect(
            Convert.FromBase64String(ProtectedToken),
            null,
            DataProtectionScope.CurrentUser));

    public static AgentConfig? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            return JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(FilePath));
        }
        catch { return null; }
    }

    public static AgentConfig Create(string deviceId, string ownerPerson, string token)
    {
        var protectedBytes = ProtectedData.Protect(
            Encoding.UTF8.GetBytes(token), null, DataProtectionScope.CurrentUser);
        return new AgentConfig(
            deviceId,
            ownerPerson,
            Convert.ToBase64String(protectedBytes),
            true);
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        File.WriteAllText(FilePath,
            JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
    }

    public static void Clear()
    {
        try { if (File.Exists(FilePath)) File.Delete(FilePath); }
        catch { }
    }
}

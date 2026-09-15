RELATO AI — TRANSCRIBER 0.4.4

CONTEÚDO
- Agent-FrameworkDependent\ — formato padrão usado quando o .NET 9 está instalado.
- Agent-SelfContained\RelatoAI.DesktopAgent.exe — fallback self-contained.
- Extension\ — extensão Chrome Relato AI.
- INSTALAR.cmd — instala/atualiza o Agent e preserva o pareamento existente.

INSTALAÇÃO DO AGENT
1. Execute INSTALAR.cmd.
2. O Agent será instalado em %LOCALAPPDATA%\RelatoAI\app.
3. O pareamento em %LOCALAPPDATA%\RelatoAI\desktop-agent.json é preservado.
4. O instalador usa DLL + dotnet quando disponível e cai para o EXE self-contained se necessário.
5. O Agent passa a iniciar automaticamente com o Windows.

EXTENSÃO CHROME
1. Abra chrome://extensions.
2. Ative o Modo do desenvolvedor.
3. Clique em "Carregar sem compactação".
4. Selecione a pasta Extension deste pacote.
5. Confirme que a versão exibida é 0.4.4.

GOOGLE MEET
- Não exige legendas/CC do Google Meet.
- Captura somente as tracks de áudio WebRTC da reunião.
- Áudio local é atribuído ao proprietário pareado; áudio remoto aparece como Participantes.
- Silêncio é filtrado antes do STT para reduzir alucinações.

VALIDAÇÃO DA BUILD
- Testes: 2/2 aprovados.
- TypeScript: sem erros.
- Desktop Agent: 0 avisos / 0 erros.
- Build completo do dashboard: aprovado.
- E2E backend: WebM → Whisper → Supabase validado.

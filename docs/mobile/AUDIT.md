# Auditoria mobile do ImobiBoard — 25/09/2026

## Repositório
- Caminho auditado: `C:\Users\Adler\imobi-board`
- Branch: `feat/mobile-app`
- Baseline antes do trabalho mobile validado: `37e9951b chore: reconcile ImobiBoard backup history`
- Primeiro commit mobile validado nesta execução: `9a203f4c feat(mobile): bootstrap native shell and responsive navigation`

## Stack real
- Monorepo pnpm.
- Frontend: React 19 + TypeScript + Vite.
- Backend/API: Cloudflare Worker em TypeScript.
- Banco/Auth/Storage: Supabase.
- Projeto Supabase: `bfzdetibfcwihfkltbkp` / `imobi-pro`.
- Schema do CRM: `imobi_board`.
- Mobile shell: Capacitor 8.
- Roteamento web: hash router próprio; não depende de servidor para rotas privadas.

## PWA antes da camada nativa
- `manifest.webmanifest` existente.
- meta tags iOS/standalone e apple-touch-icon existentes.
- Não foi encontrada implementação de service worker de cache/offline do CRM. A camada mobile trata perda de conexão de forma explícita; não foi transformado em CRM offline.

## Autenticação
- Supabase Auth.
- Web persiste sessão pelo storage padrão.
- App nativo usa secure storage via `@aparajita/capacitor-secure-storage`.
- Refresh token automático permanece habilitado.
- Service role não está no bundle do frontend.
- Modo Master usa RPCs próprias e registra entrada/saída de tenant.

## Multi-tenant / segurança
- Dados do app usam o schema `imobi_board`.
- Queries de frontend incluem `tenant_id`, mas a proteção final é RLS no banco.
- Teste real executado novamente em 25/09/2026 com role `authenticated` e JWT do tenant Terra Concreta:
  - oportunidades do próprio tenant visíveis: 14;
  - oportunidades do tenant Imobiliaria Horizonte visíveis: 0.
- Teste real da RPC de registro de dispositivo:
  - registro no próprio tenant: permitido;
  - tentativa de registrar dispositivo em outro tenant: rejeitada com SQLSTATE 42501.
- Membership interna de Master é excluída de inscrição automática de push de clientes.
- Deep link apenas seleciona uma oportunidade; o carregamento ainda passa pelo Supabase/RLS.

## UX mobile implementada
- bottom navigation;
- menu "Mais";
- cards móveis na lista de leads;
- pipeline horizontal com snap e troca explícita de etapa no card para touch;
- safe-area/notch;
- inputs com tamanho adequado para impedir zoom acidental;
- sem scroll horizontal global;
- câmera/galeria para fotos;
- share sheet;
- WhatsApp nativo com fallback web;
- haptics pontuais;
- aviso de offline;
- bloqueio biométrico opcional no cold start e ao voltar do background;
- conteúdo autenticado não é exibido antes da checagem local de biometria;
- notificações somente após permissão explícita do usuário.

## Capacitor / plataformas
- App ID: `com.imobiboard.crm`.
- Pesquisa pública exata do bundle id não retornou conflito conhecido em 25/09/2026.
- Android: projeto gerado e build release executado com targetSdk 36.
- iOS: projeto gerado; archive final exige macOS/Xcode e Apple signing.

## Android
- targetSdk 36.
- minSdk 24.
- versão: 1.0.0 / versionCode 1.
- R8/minify e shrinkResources ativados para release.
- upload key criada fora do repositório em:
  `C:\Users\Adler\.imobiboard\signing\`
- essa pasta deve ser copiada para backup seguro antes da publicação.
- nenhuma senha/chave de assinatura foi adicionada ao Git.

## iOS
- bundle id `com.imobiboard.crm`.
- versão 1.0.0 / build 1.
- URL scheme `imobiboard://`.
- textos de Face ID, câmera e biblioteca adicionados ao Info.plist.
- bridge de registro APNs adicionada ao AppDelegate.
- falta signing/capability efetiva em conta Apple e archive em macOS.

## Push
- tabela `imobi_board.mobile_devices` com RLS.
- RPC autenticada de registro de aparelho.
- payload de novo lead gerado server-side e filtrado por tenant/membership.
- Worker tem implementação preparada para FCM Android e APNs iOS.
- credenciais privadas permanecem previstas somente como secrets do Worker.
- falta fornecer/configurar Firebase/FCM e Apple APNs para entrega real em aparelhos.

## Testes executados
- web TypeScript build: passou.
- web production build: passou.
- Vitest: 13/13 passaram.
- Worker TypeScript check: passou.
- Capacitor sync Android/iOS: passou.
- Android release build com R8 e assinatura de upload: passou após sync com os 14 plugins Capacitor, incluindo Keyboard.
- RLS cross-tenant: passou.
- RPC de dispositivo cross-tenant: bloqueada corretamente.
- Testes em aparelho Android/iPhone físico ainda não executados.
- iOS archive não pode ser executado nesta máquina Windows.

## Pontos ainda obrigatórios antes de submissão
- configurar Firebase e obter `google-services.json`;
- configurar secrets FCM no Worker;
- criar APNs key/certificado na conta Apple e configurar secrets;
- archive/assinatura iOS em macOS/Xcode;
- screenshots reais;
- conta demo de reviewer;
- Play Console/App Store Connect e formulários finais;
- smoke tests em dispositivos reais.

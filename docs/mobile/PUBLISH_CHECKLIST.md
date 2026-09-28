# ImobiBoard mobile — checklist de publicação

Estado atualizado em 28/09/2026. Não marcar um item como validado sem teste real.

## Android — código e build
- [x] App ID `com.imobiboard.crm`.
- [x] Capacitor sincronizado.
- [x] targetSdk 36 / minSdk 24.
- [x] R8/minify e shrinkResources em release.
- [x] Upload keystore fora do repositório.
- [x] AAB release assinado gerado.
- [x] Build final executado com JDK 21.
- [ ] Firebase autenticado nesta máquina.
- [ ] App Android cadastrado no Firebase.
- [ ] `google-services.json` instalado em `apps/web/android/app/`.
- [ ] Credenciais server-side FCM configuradas como secrets do Worker.
- [ ] Push de novo lead validado em aparelho Android físico.
- [ ] Deep link de push validado em aparelho Android físico.
- [ ] Biometria, câmera, share, WhatsApp e comportamento offline validados em aparelho físico.

### Comando de build Android
Use JDK 21. O JBR atual do Android Studio nesta máquina está em Java 25 e não é compatível com o Gradle atual.

```powershell
$env:JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot'
$env:Path="$env:JAVA_HOME\bin;$env:Path"
cd C:\Users\Adler\imobi-board\apps\web
pnpm exec cap sync android
cd android
.\gradlew.bat bundleRelease
```

Saída esperada:
`apps/web/android/app/build/outputs/bundle/release/app-release.aab`

## iOS — código
- [x] Projeto Capacitor iOS gerado.
- [x] Bundle ID `com.imobiboard.crm`.
- [x] URL scheme `imobiboard://`.
- [x] Face ID/câmera/fotos declarados no Info.plist.
- [x] Bridge APNs no AppDelegate.
- [x] Push Notifications capability preparada.
- [x] `aps-environment`: development em Debug, production em Release.
- [x] `PrivacyInfo.xcprivacy` incluído no target com razão `CA92.1` para `UserDefaults`.
- [x] Compilação do target iOS em runner macOS/Xcode 26 validada por GitHub Actions.
- [ ] Bundle ID registrado na conta Apple Developer.
- [ ] Team/signing configurados.
- [ ] APNs Key criada e secrets configurados no Worker.
- [ ] Archive Release realizado em macOS/Xcode.
- [ ] Push/deep link/Face ID/câmera testados em iPhone físico.

## Backend e segurança
- [x] Sessão móvel em secure storage nativo.
- [x] Nenhuma service role/private key no bundle do frontend.
- [x] RLS continua sendo a barreira final de tenant.
- [x] Registro de dispositivo exige membership ativa e não interna.
- [x] Master interno não é inscrito em push de tenant.
- [x] Deep link valida o ID no Supabase/RLS antes da navegação.
- [x] Deep link de outro tenant testado e bloqueado.
- [x] URL forjada e spoof de tenant via sessionStorage testados end-to-end em viewport mobile; sem troca de tenant/vazamento.
- [x] Token push é desativado antes do logout.
- [x] Listeners antigos de push são removidos na troca de sessão/tenant.
- [x] Índice duplicado de `mobile_devices` removido.
- [x] Política de privacidade pública e termos disponíveis.

## Cloudflare Worker — secrets que ainda precisam existir
Não colocar nenhum destes valores em Git, Vite, Capacitor config ou bundle:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_PRIVATE_KEY`
- `APNS_BUNDLE_ID=com.imobiboard.crm`
- `APNS_SANDBOX=false` em produção

## Loja
- [x] Descrição curta/completa.
- [x] Categoria e palavras-chave.
- [x] Release notes.
- [x] Mapa Data Safety / App Privacy.
- [x] Política de privacidade real.
- [x] Feature graphic inicial da Play Store.
- [ ] Screenshots finais tirados de builds/aparelhos reais.
- [ ] Conta dedicada para reviewer.
- [ ] Formulários finais no Play Console.
- [ ] Formulários finais no App Store Connect.
- [ ] Upload do AAB no Play Console.
- [ ] Upload do archive no App Store Connect.

## Bloqueios externos reais
1. Firebase: a CLI confirmou ausência de login Google nesta máquina.
2. Apple: o projeto já compila em macOS/Xcode 26 via CI; cadastro do Bundle ID, APNs, signing e archive assinado ainda exigem autorização da conta Apple Developer.
3. Publicação: Play Console/App Store Connect podem exigir aceite de termos, 2FA e etapas da conta.

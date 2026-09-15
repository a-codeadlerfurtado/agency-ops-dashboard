# frozen_string_literal: true

pairs = {
  'INSTALLATION_NAME' => 'ImoBia',
  'BRAND_NAME' => 'ImoBia',
  'BRAND_URL' => ENV.fetch('FRONTEND_URL'),
  'WIDGET_BRAND_URL' => ENV.fetch('FRONTEND_URL'),
  'TERMS_URL' => ENV.fetch('FRONTEND_URL'),
  'PRIVACY_URL' => ENV.fetch('FRONTEND_URL'),
  'DISPLAY_MANIFEST' => false,
  'ENABLE_ACCOUNT_SIGNUP' => false,
  'DISABLE_META_INBOX_CREATION' => false,
  'DISABLE_META_MESSAGE_SENDING' => false,
  'WHATSAPP_APP_ID' => ENV['WHATSAPP_APP_ID'],
  'WHATSAPP_CONFIGURATION_ID' => ENV['WHATSAPP_CONFIGURATION_ID'],
  'WHATSAPP_API_VERSION' => ENV.fetch('WHATSAPP_API_VERSION', 'v26.0')
}

pairs.each do |name, value|
  config = InstallationConfig.where(name: name).first_or_initialize
  config.value = value
  config.locked = false if config.respond_to?(:locked=)
  config.save!
end

GlobalConfig.clear_cache
::Redis::Alfred.delete(::Redis::Alfred::CHATWOOT_INSTALLATION_ONBOARDING)
puts 'imobia_runtime_config_applied'
class Whatsapp::MessageTemplateCreationService
  CATEGORIES = %w[MARKETING UTILITY AUTHENTICATION].freeze
  NAME_PATTERN = /\A[a-z0-9_]{1,512}\z/
  LANGUAGE_PATTERN = /\A[a-z]{2,3}(?:_[A-Z]{2})?\z/

  def initialize(channel, params)
    @channel = channel
    @params = params.to_h.deep_stringify_keys
  end

  def perform
    validate!
    response = HTTParty.post(
      "#{api_base_path}/#{api_version}/#{waba_id}/message_templates",
      headers: request_headers,
      body: payload.to_json
    )
    raise "Template creation failed: #{meta_error(response)}" unless response.success?

    @channel.provider_service.sync_templates
    response.parsed_response
  end

  private

  def validate!
    raise ArgumentError, 'WhatsApp Cloud API is required' unless @channel.provider == 'whatsapp_cloud'
    raise ArgumentError, 'WABA ID is missing' if waba_id.blank?
    raise ArgumentError, 'Template access token is missing' if access_token.blank?
    raise ArgumentError, 'Invalid template name' unless @params['name'].to_s.match?(NAME_PATTERN)
    raise ArgumentError, 'Invalid template language' unless @params['language'].to_s.match?(LANGUAGE_PATTERN)
    raise ArgumentError, 'Invalid template category' unless CATEGORIES.include?(@params['category'].to_s.upcase)
    raise ArgumentError, 'Template body is required' if @params['body'].to_s.strip.blank?
  end

  def payload
    data = {
      name: @params['name'],
      language: @params['language'],
      category: @params['category'].to_s.upcase,
      components: [{ type: 'BODY', text: @params['body'].to_s.strip }]
    }
    data[:parameter_format] = @params['parameter_format'] if @params['parameter_format'].present?
    data
  end

  def access_token
    @channel.template_access_token
  end

  def waba_id
    @channel.provider_config['business_account_id']
  end

  def api_version
    GlobalConfigService.load('WHATSAPP_API_VERSION', 'v26.0')
  end

  def api_base_path
    ENV.fetch('WHATSAPP_CLOUD_BASE_URL', 'https://graph.facebook.com')
  end
  def request_headers
    {
      'Authorization' => "Bearer #{access_token}",
      'Content-Type' => 'application/json'
    }
  end

  def meta_error(response)
    parsed = response.parsed_response
    return parsed.dig('error', 'message') if parsed.is_a?(Hash)

    response.body
  end
end

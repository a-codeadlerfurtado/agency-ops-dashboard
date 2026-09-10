update agency_ops.meeting_integration_providers
set auth_mode='OAUTH2',
    capabilities='["READ_CONTEXT","SEND_FOLLOWUP","LINK_CONTACT","ACCOUNT_IDENTITY"]'::jsonb,
    metadata=(metadata - 'transport' - 'rollout') || '{"transport":"META_WHATSAPP_BUSINESS_OFFICIAL","rollout":"meta_embedded_signup_required","zapi_reuse":false}'::jsonb,
    updated_at=now()
where provider_key='WHATSAPP';
ALTER TABLE agency_ops.whatsapp_media_context
 ADD COLUMN visual_status text NOT NULL DEFAULT 'PENDING' CHECK (visual_status IN ('PENDING','PROCESSING','DONE','RETRY','REVIEW')),
 ADD COLUMN visual_attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN visual_next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN visual_locked_at timestamptz,
 ADD COLUMN visual_lease uuid,
 ADD COLUMN visual_error text;
CREATE INDEX whatsapp_media_visual_due ON agency_ops.whatsapp_media_context(visual_next_attempt_at,message_row_id) WHERE media_type='video' AND visual_status IN ('PENDING','RETRY','PROCESSING');
CREATE OR REPLACE FUNCTION agency_ops.claim_whatsapp_video_visual()
RETURNS SETOF agency_ops.whatsapp_media_context LANGUAGE plpgsql SECURITY INVOKER SET search_path=agency_ops,pg_temp AS $$
BEGIN
 UPDATE agency_ops.whatsapp_media_context SET visual_status='RETRY',visual_locked_at=NULL,visual_lease=NULL
 WHERE visual_status='PROCESSING' AND visual_locked_at<now()-interval '10 minutes';
 RETURN QUERY WITH candidate AS (
 SELECT m.message_row_id FROM agency_ops.whatsapp_media_context m
 JOIN agency_ops.whatsapp_group_registry g ON g.chat_id=m.chat_id AND g.group_kind='CLIENTE' AND g.client_id IS NOT DISTINCT FROM m.client_id
 WHERE m.media_type='video' AND m.storage_path IS NOT NULL AND m.status IN ('PARTIAL','REVIEW','DONE')
 AND m.visual_status IN ('PENDING','RETRY') AND m.visual_attempts<5 AND m.visual_next_attempt_at<=now()
 ORDER BY CASE WHEN m.status='PARTIAL' THEN 0 ELSE 1 END,m.message_row_id DESC FOR UPDATE OF m SKIP LOCKED LIMIT 1
 ) UPDATE agency_ops.whatsapp_media_context m SET visual_status='PROCESSING',visual_attempts=visual_attempts+1,visual_locked_at=now(),visual_lease=gen_random_uuid()
 FROM candidate c WHERE m.message_row_id=c.message_row_id RETURNING m.*;
END $$;
REVOKE ALL ON FUNCTION agency_ops.claim_whatsapp_video_visual() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION agency_ops.claim_whatsapp_video_visual() TO service_role;

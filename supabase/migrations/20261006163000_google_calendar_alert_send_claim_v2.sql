-- Prevent duplicate WhatsApp sends when Google delivers overlapping webhook notifications.
alter table agency_ops.google_calendar_alerts
  drop constraint if exists google_calendar_alerts_whatsapp_status_check;

alter table agency_ops.google_calendar_alerts
  add constraint google_calendar_alerts_whatsapp_status_check
  check (whatsapp_status in ('PENDING','SENDING','SENT','FAILED','SKIPPED'));

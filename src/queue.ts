import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './config.js';

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const whatsappQueue = new Queue('whatsapp-ingress', { connection });


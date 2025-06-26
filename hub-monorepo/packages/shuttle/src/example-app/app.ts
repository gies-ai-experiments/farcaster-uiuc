import {
  DB,
  getDbClient,
  getHubClient,
  MessageHandler,
  StoreMessageOperation,
  MessageReconciliation,
  RedisClient,
  HubEventProcessor,
  EventStreamHubSubscriber,
  EventStreamConnection,
  HubEventStreamConsumer,
  HubSubscriber,
  MessageState,
} from "../index"; // If you want to use this as a standalone app, replace this import with "@farcaster/shuttle"
import { AppDb, migrateToLatest, Tables } from "./db";
import {
  bytesToHexString,
  getStorageUnitExpiry,
  getStorageUnitType,
  HubEvent,
  HubInfoRequest,
  isCastAddMessage,
  isCastRemoveMessage,
  isIdRegisterOnChainEvent,
  isMergeOnChainHubEvent,
  isSignerOnChainEvent,
  isStorageRentOnChainEvent,
  Message,
} from "@farcaster/hub-nodejs";
import { log } from "./log";
import { Command } from "@commander-js/extra-typings";
import { readFileSync } from "fs";
import {
  BACKFILL_FIDS,
  CONCURRENCY,
  HUB_HOST,
  HUB_SSL,
  POSTGRES_SCHEMA,
  POSTGRES_URL,
  REDIS_URL,
  SHARD_INDICES,
  SHARD_INDEX,
  SUBSCRIBE_RPC_TIMEOUT,
  TOTAL_SHARDS,
  USE_MULTIPLE_SHARDS,
  USE_STREAMING_RPCS_FOR_BACKFILL,
} from "./env.js";
import * as process from "node:process";
import url from "node:url";
import { ok, Result } from "neverthrow";
import { getQueue, getWorker } from "./worker";
import { Queue } from "bullmq";
import { bytesToHex, farcasterTimeToDate } from "../utils";

const hubId = "shuttle";

export class App implements MessageHandler {
  private readonly db: DB;
  private readonly dbSchema: string;
  private hubSubscribers: HubSubscriber[];
  private streamConsumers: HubEventStreamConsumer[];
  public redis: RedisClient;
  private readonly hubId;

  constructor(
    db: DB,
    dbSchema: string,
    redis: RedisClient,
    hubSubscribers: HubSubscriber[],
    streamConsumers: HubEventStreamConsumer[],
  ) {
    this.db = db;
    this.dbSchema = dbSchema;
    this.redis = redis;
    this.hubSubscribers = hubSubscribers;
    this.hubId = hubId;
    this.streamConsumers = streamConsumers;
  }

  static create(
    dbUrl: string,
    dbSchema: string,
    redisUrl: string,
    hubUrl: string,
    totalShards: number,
    shardIndex: number,
    hubSSL = false,
  ) {
    const db = getDbClient(dbUrl, dbSchema);
    const hub = getHubClient(hubUrl, { ssl: hubSSL });
    const redis = RedisClient.create(redisUrl);

    if (USE_MULTIPLE_SHARDS && SHARD_INDICES.length > 0) {
      log.info(`Creating subscribers for multiple shards: ${SHARD_INDICES.join(", ")}`);
      
      const hubSubscribers: HubSubscriber[] = [];
      const streamConsumers: HubEventStreamConsumer[] = [];

      for (const currentShardIndex of SHARD_INDICES) {
        const eventStreamForWrite = new EventStreamConnection(redis.client);
        const eventStreamForRead = new EventStreamConnection(redis.client);
        const shardKey = totalShards === 0 ? "all" : `${currentShardIndex}`;
        
        const hubSubscriber = new EventStreamHubSubscriber(
          `${hubId}-shard-${currentShardIndex}`,
          hub,
          eventStreamForWrite,
          redis,
          shardKey,
          log,
          null,
          totalShards,
          currentShardIndex,
          SUBSCRIBE_RPC_TIMEOUT,
        );
        
        const streamConsumer = new HubEventStreamConsumer(hub, eventStreamForRead, shardKey);
        
        hubSubscribers.push(hubSubscriber);
        streamConsumers.push(streamConsumer);
      }

      return new App(db, dbSchema, redis, hubSubscribers, streamConsumers);
    } else {
      const eventStreamForWrite = new EventStreamConnection(redis.client);
      const eventStreamForRead = new EventStreamConnection(redis.client);
      const shardKey = totalShards === 0 ? "all" : `${shardIndex}`;
      const hubSubscriber = new EventStreamHubSubscriber(
        hubId,
        hub,
        eventStreamForWrite,
        redis,
        shardKey,
        log,
        null,
        totalShards,
        shardIndex,
        SUBSCRIBE_RPC_TIMEOUT,
      );
      const streamConsumer = new HubEventStreamConsumer(hub, eventStreamForRead, shardKey);

      return new App(db, dbSchema, redis, [hubSubscriber], [streamConsumer]);
    }
  }

  async onHubEvent(event: HubEvent, txn: DB): Promise<boolean> {
    if (isMergeOnChainHubEvent(event)) {
      const onChainEvent = event.mergeOnChainEventBody.onChainEvent;
      let body = {};
      if (isIdRegisterOnChainEvent(onChainEvent)) {
        body = {
          eventType: onChainEvent.idRegisterEventBody.eventType,
          from: bytesToHex(onChainEvent.idRegisterEventBody.from),
          to: bytesToHex(onChainEvent.idRegisterEventBody.to),
          recoveryAddress: bytesToHex(onChainEvent.idRegisterEventBody.recoveryAddress),
        };
      } else if (isSignerOnChainEvent(onChainEvent)) {
        body = {
          eventType: onChainEvent.signerEventBody.eventType,
          key: bytesToHex(onChainEvent.signerEventBody.key),
          keyType: onChainEvent.signerEventBody.keyType,
          metadata: bytesToHex(onChainEvent.signerEventBody.metadata),
          metadataType: onChainEvent.signerEventBody.metadataType,
        };
      } else if (isStorageRentOnChainEvent(onChainEvent)) {
        body = {
          eventType: getStorageUnitType(onChainEvent),
          expiry: getStorageUnitExpiry(onChainEvent),
          units: onChainEvent.storageRentEventBody.units,
          payer: bytesToHex(onChainEvent.storageRentEventBody.payer),
        };
      }
      try {
        await (txn as AppDb)
          .insertInto("onchain_events")
          .values({
            fid: onChainEvent.fid,
            timestamp: new Date(onChainEvent.blockTimestamp * 1000),
            blockNumber: onChainEvent.blockNumber,
            logIndex: onChainEvent.logIndex,
            txHash: onChainEvent.transactionHash,
            type: onChainEvent.type,
            body: body,
          })
          .execute();
        log.info(`Recorded OnchainEvent ${onChainEvent.type} for fid  ${onChainEvent.fid}`);
      } catch (e) {
        log.error("Failed to insert onchain event", e);
      }
    }
    return false;
  }

  async handleMessageMerge(
    message: Message,
    txn: DB,
    operation: StoreMessageOperation,
    state: MessageState,
    isNew: boolean,
    wasMissed: boolean,
  ): Promise<void> {
    if (!isNew) {
      // Message was already in the db, no-op
      return;
    }

    const appDB = txn as unknown as AppDb; // Need this to make typescript happy, not clean way to "inherit" table types

    // Example of how to materialize casts into a separate table. Insert casts into a separate table, and mark them as deleted when removed
    // Note that since we're relying on "state", this can sometimes be invoked twice. e.g. when a CastRemove is merged, this call will be invoked 2 twice:
    // castAdd, operation=delete, state=deleted (the cast that the remove is removing)
    // castRemove, operation=merge, state=deleted (the actual remove message)
    const isCastMessage = isCastAddMessage(message) || isCastRemoveMessage(message);
    if (isCastMessage && state === "created") {
      await appDB
        .insertInto("casts")
        .values({
          fid: message.data.fid,
          hash: message.hash,
          text: message.data.castAddBody?.text || "",
          timestamp: farcasterTimeToDate(message.data.timestamp) || new Date(),
        })
        .execute();
    } else if (isCastMessage && state === "deleted") {
      await appDB
        .updateTable("casts")
        .set({ deletedAt: farcasterTimeToDate(message.data.timestamp) || new Date() })
        .where("hash", "=", message.hash)
        .execute();
    }

    const messageDesc = wasMissed ? `missed message (${operation})` : `message (${operation})`;
    log.info(`${state} ${messageDesc} ${bytesToHexString(message.hash)._unsafeUnwrap()} (type ${message.data?.type})`);
  }

  async start() {
    await this.ensureMigrations();
    // Hub subscriber listens to events from the hub and writes them to a redis stream. This allows for scaling by
    // splitting events to multiple streams
    for (const hubSubscriber of this.hubSubscribers) {
      await hubSubscriber.start();
    }

    // Sleep 10 seconds to give the subscriber a chance to create the stream for the first time.
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    log.info("Starting stream consumer");
    // Stream consumer reads from the redis stream and inserts them into postgres
    for (const streamConsumer of this.streamConsumers) {
      await streamConsumer.start(async (event) => {
        await this.processHubEvent(event);
        return ok({ skipped: false });
      });
    }
  }

  async reconcileFids(fids: number[]) {
    // Reconcile messages from ALL shards
    for (let shardIdx = 0; shardIdx < this.hubSubscribers.length; shardIdx++) {
      const hubClient = this.hubSubscribers[shardIdx].hubClient;
      if (!hubClient) {
        log.warn(`Hub client for shard ${shardIdx + 1} is not available, skipping reconciliation`);
        continue;
      }
      
      log.info(`Starting reconciliation for ${fids.length} FIDs on shard ${shardIdx + 1}`);
      
      const reconciler = new MessageReconciliation(
        hubClient,
        this.db,
        log,
        undefined,
        USE_STREAMING_RPCS_FOR_BACKFILL,
      );
      
      for (const fid of fids) {
        try {
          await reconciler.reconcileMessagesForFid(
            fid,
            async (message, missingInDb, prunedInDb, revokedInDb) => {
              if (missingInDb) {
                await HubEventProcessor.handleMissingMessage(this.db, message, this);
              } else if (prunedInDb || revokedInDb) {
                const messageDesc = prunedInDb ? "pruned" : revokedInDb ? "revoked" : "existing";
                log.info(`Reconciled ${messageDesc} message ${bytesToHexString(message.hash)._unsafeUnwrap()} from shard ${shardIdx + 1}`);
              }
            },
            async (message, missingInHub) => {
              if (missingInHub) {
                log.info(`Message ${bytesToHexString(message.hash)._unsafeUnwrap()} is missing in shard ${shardIdx + 1} hub`);
              }
            },
          );
        } catch (error) {
          log.error(`Failed to reconcile FID ${fid} on shard ${shardIdx + 1}:`, error);
          // Continue with next FID
        }
      }
      
      log.info(`Completed reconciliation for shard ${shardIdx + 1}`);
    }
  }

  async discoverAllFidsFromHub(): Promise<number[]> {
    log.info("Discovering all FIDs using hub's native getFids API...");
    const allFids: Set<number> = new Set();
    
    // Use the hub's native getFids API for each shard
    for (let shardIdx = 0; shardIdx < this.hubSubscribers.length; shardIdx++) {
      const hubClient = this.hubSubscribers[shardIdx].hubClient;
      if (!hubClient) {
        log.warn(`Hub client for shard ${shardIdx + 1} is not available, skipping`);
        continue;
      }
      
      log.info(`Getting FIDs from shard ${shardIdx + 1}...`);
      let pageToken: Uint8Array | undefined;
      let totalForShard = 0;
      
      try {
        do {
          const result = await hubClient.getFids({ 
            shardId: shardIdx + 1,
            pageSize: 1000, // Large page size for efficiency
            pageToken 
          });
          
          if (result.isErr()) {
            log.error(`Failed to get FIDs from shard ${shardIdx + 1}: ${result.error.message}`);
            break;
          }
          
          const { fids, nextPageToken } = result.value;
          fids.forEach(fid => allFids.add(fid));
          totalForShard += fids.length;
          pageToken = nextPageToken;
          
          log.info(`Got ${fids.length} FIDs from shard ${shardIdx + 1}, total for shard: ${totalForShard}, overall total: ${allFids.size}`);
          
        } while (pageToken && pageToken.length > 0);
        
        log.info(`Completed shard ${shardIdx + 1}: ${totalForShard} FIDs`);
        
      } catch (error) {
        log.error(`Error getting FIDs from shard ${shardIdx + 1}:`, error);
      }
    }
    
    const fidArray = Array.from(allFids).sort((a, b) => a - b);
    log.info(`Native FID discovery complete. Found ${fidArray.length} total FIDs from ${this.hubSubscribers.length} shards`);
    if (fidArray.length > 0) {
      log.info(`FID range: ${Math.min(...fidArray)} - ${Math.max(...fidArray)}`);
    }
    
    return fidArray;
  }

  async getLatestFidFromHub(): Promise<number> {
    // Try to get the latest FID from any shard
    for (let shardIdx = 0; shardIdx < this.hubSubscribers.length; shardIdx++) {
      const hubClient = this.hubSubscribers[shardIdx].hubClient;
      if (!hubClient) continue;
      
      try {
        // Get hub info to find the latest FID
        const infoResult = await hubClient.getInfo();
        if (infoResult.isErr()) continue;
        
        // Try to get FIDs in reverse order to find the highest FID quickly
        const fidsResult = await hubClient.getFids({ 
          shardId: shardIdx + 1,
          pageSize: 100,
          reverse: true // Get latest FIDs first
        });
        
        if (fidsResult.isOk() && fidsResult.value.fids.length > 0) {
          const latestFid = Math.max(...fidsResult.value.fids);
          log.info(`Found latest FID ${latestFid} from shard ${shardIdx + 1}`);
          return latestFid;
        }
      } catch (error) {
        log.debug(`Error getting latest FID from shard ${shardIdx + 1}: ${error}`);
      }
    }
    
    // Default fallback if we can't determine latest FID
    log.warn("Could not determine latest FID from hub, using conservative estimate");
    return 1000000; // Conservative fallback
  }

  async discoverAllFids(): Promise<number[]> {
    // Try the native getFids API first (much more efficient)
    try {
      const nativeFids = await this.discoverAllFidsFromHub();
      if (nativeFids.length > 0) {
        log.info(`Successfully discovered ${nativeFids.length} FIDs using native API`);
        return nativeFids;
      }
      log.warn("Native getFids API returned no FIDs, falling back to manual discovery");
    } catch (error) {
      log.warn(`Native getFids API failed: ${error}, falling back to manual discovery`);
    }
    
    // Fallback to manual discovery with dynamic range
    log.info("Discovering all FIDs from hub using manual method...");
    const latestFid = await this.getLatestFidFromHub();
    const searchRange = latestFid + 100000; // Search a bit beyond the latest known FID
    log.info(`Will search for FIDs up to ${searchRange} (latest known: ${latestFid})`);
    
    const allFids: Set<number> = new Set();
    let currentFid = 1;
    const batchSize = 500; // Increased batch size for efficiency
    
    while (currentFid <= searchRange) {
      try {
        log.info(`Checking FIDs starting from ${currentFid}... (Found ${allFids.size} so far)`);
        
        // Try to get any messages for a batch of FIDs to see which ones exist
        let foundAnyInBatch = false;
        const fidBatch: number[] = [];
        
        for (let i = 0; i < batchSize; i++) {
          const fid = currentFid + i;
          if (fid > searchRange) break;
          
          let fidHasMessages = false;
          
          try {
            // Check ALL shards for this FID
            for (let shardIdx = 0; shardIdx < this.hubSubscribers.length && !fidHasMessages; shardIdx++) {
              const hubClient = this.hubSubscribers[shardIdx].hubClient;
              
              // Check for different types of messages on this shard
              const messageChecks = [
                // Casts
                () => hubClient?.getAllCastMessagesByFid({ fid, pageSize: 1 }),
                // Reactions  
                () => hubClient?.getAllReactionMessagesByFid({ fid, pageSize: 1 }),
                // Links/Follows
                () => hubClient?.getAllLinkMessagesByFid({ fid, pageSize: 1 }),
                // Verifications
                () => hubClient?.getAllVerificationMessagesByFid({ fid, pageSize: 1 }),
                // User data (profiles)
                () => hubClient?.getAllUserDataMessagesByFid({ fid, pageSize: 1 }),
              ];
              
              // Check each message type until we find one on this shard
              for (const checkFn of messageChecks) {
                if (fidHasMessages) break;
                
                try {
                  const result = await checkFn();
                  if (result?.isOk() && result.value.messages.length > 0) {
                    fidHasMessages = true;
                    log.debug(`Found FID ${fid} with messages on shard ${shardIdx + 1}`);
                    break;
                  }
                } catch (error) {
                  // Continue to next message type
                  log.debug(`FID ${fid} check failed for one message type on shard ${shardIdx + 1}: ${error}`);
                }
              }
            }
            
            if (fidHasMessages) {
              fidBatch.push(fid);
              foundAnyInBatch = true;
            }
            
          } catch (error) {
            // FID doesn't exist or has no messages, continue
            log.debug(`FID ${fid} has no messages on any shard`);
          }
        }
        
        fidBatch.forEach(fid => allFids.add(fid));
        currentFid += batchSize;
        
        // If we didn't find any FIDs in this batch, try more batches before giving up
        if (!foundAnyInBatch) {
          log.info(`No FIDs found in batch starting at ${currentFid - batchSize}, checking more batches...`);
          let emptyBatches = 1;
          
          // Dynamic empty batch limit based on how close we are to the known latest FID
          const remainingRange = searchRange - currentFid;
          const maxEmptyBatches = remainingRange > 500000 ? 200 : 50; // More patience if we're far from the end
          
          while (emptyBatches < maxEmptyBatches && currentFid <= searchRange) {
            let foundInSkippedBatch = false;
            for (let i = 0; i < batchSize; i++) {
              const fid = currentFid + i;
              if (fid > searchRange) break;
              
              let fidHasMessages = false;
              
              try {
                // Same comprehensive check for sparse areas - ALL shards
                for (let shardIdx = 0; shardIdx < this.hubSubscribers.length && !fidHasMessages; shardIdx++) {
                  const hubClient = this.hubSubscribers[shardIdx].hubClient;
                  
                  const messageChecks = [
                    () => hubClient?.getAllCastMessagesByFid({ fid, pageSize: 1 }),
                    () => hubClient?.getAllReactionMessagesByFid({ fid, pageSize: 1 }),
                    () => hubClient?.getAllLinkMessagesByFid({ fid, pageSize: 1 }),
                    () => hubClient?.getAllVerificationMessagesByFid({ fid, pageSize: 1 }),
                    () => hubClient?.getAllUserDataMessagesByFid({ fid, pageSize: 1 }),
                  ];
                  
                  for (const checkFn of messageChecks) {
                    if (fidHasMessages) break;
                    
                    try {
                      const result = await checkFn();
                      if (result?.isOk() && result.value.messages.length > 0) {
                        fidHasMessages = true;
                        log.debug(`Found FID ${fid} in sparse area on shard ${shardIdx + 1}`);
                        break;
                      }
                    } catch (error) {
                      // Continue
                    }
                  }
                }
                
                if (fidHasMessages) {
                  allFids.add(fid);
                  foundInSkippedBatch = true;
                  foundAnyInBatch = true;
                }
              } catch (error) {
                // Continue
              }
            }
            
            currentFid += batchSize;
            if (!foundInSkippedBatch) {
              emptyBatches++;
            } else {
              emptyBatches = 0; // Reset counter if we found something
            }
            
            // Log progress during sparse area search
            if (emptyBatches % 20 === 0) {
              log.info(`Checked ${emptyBatches} empty batches in sparse area, continuing search... (Found ${allFids.size} FIDs total)`);
            }
          }
          
          if (!foundAnyInBatch) {
            log.info(`No more FIDs found after checking ${maxEmptyBatches} empty batches. Discovery complete.`);
            break;
          }
        }
        
        // Log progress every 10000 FIDs checked (not found)
        if (currentFid % 10000 === 0) {
          log.info(`Checked up to FID ${currentFid}, discovered ${allFids.size} FIDs so far...`);
        }
        
        // Log progress every 5000 FIDs found
        if (allFids.size > 0 && allFids.size % 5000 === 0) {
          log.info(`Discovered ${allFids.size} FIDs so far...`);
        }
        
      } catch (error) {
        log.error(`Error during FID discovery at FID ${currentFid}:`, error);
        // Continue with next batch
        currentFid += batchSize;
      }
    }
    
    const fidArray = Array.from(allFids).sort((a, b) => a - b);
    log.info(`Manual FID discovery complete. Found ${fidArray.length} total FIDs: [${Math.min(...fidArray)} - ${Math.max(...fidArray)}]`);
    if (fidArray.length > 0) {
      log.info(`Discovery captured ${((fidArray.length / (Math.max(...fidArray) - Math.min(...fidArray) + 1)) * 100).toFixed(1)}% of the FID range`);
    }
    log.info(`FIDs discovered from ${this.hubSubscribers.length} shards`);
    
    return fidArray;
  }

  async backfillFids(fids: number[], backfillQueue: Queue) {
    const startedAt = Date.now();
    if (fids.length === 0) {
      log.info("No specific FIDs provided, discovering all FIDs from hub...");
      
      try {
        const discoveredFids = await this.discoverAllFids();
        
        if (discoveredFids.length === 0) {
          log.warn("No FIDs discovered from hub. Nothing to backfill.");
          return;
        }
        
        log.info(`Queuing up ${discoveredFids.length} discovered FIDs for backfill`);
        
        // Create batches of discovered FIDs
        const batchSize = 10;
        for (let i = 0; i < discoveredFids.length; i += batchSize) {
          const fidBatch = discoveredFids.slice(i, i + batchSize);
          await backfillQueue.add("reconcile", { fids: fidBatch });
        }
        
      } catch (error) {
        log.error("Failed to discover FIDs from hub:", error);
        throw new Error("Failed to discover FIDs for backfill");
      }
    } else {
      log.info(`Queuing up ${fids.length} specified FIDs for backfill`);
      await backfillQueue.add("reconcile", { fids });
    }
    
    await backfillQueue.add("completionMarker", { startedAt });
    log.info("Backfill jobs queued");
  }

  private async processHubEvent(hubEvent: HubEvent) {
    await HubEventProcessor.processHubEvent(this.db, hubEvent, this);
  }

  async ensureMigrations() {
    const result = await migrateToLatest(this.db, this.dbSchema, log);
    if (result.isErr()) {
      log.error("Failed to migrate database", result.error);
      throw result.error;
    }
  }

  async stop() {
    for (const hubSubscriber of this.hubSubscribers) {
      hubSubscriber.stop();
    }
    const lastEventId = await this.redis.getLastProcessedEvent(this.hubId);
    log.info(`Stopped at eventId: ${lastEventId}`);
  }
}

//If the module is being run directly, start the shuttle
if (import.meta.url.endsWith(url.pathToFileURL(process.argv[1] || "").toString())) {
  async function start() {
    log.info(`Creating app connecting to: ${POSTGRES_URL}, ${REDIS_URL}, ${HUB_HOST}`);
    const app = App.create(POSTGRES_URL, POSTGRES_SCHEMA, REDIS_URL, HUB_HOST, TOTAL_SHARDS, SHARD_INDEX, HUB_SSL);
    log.info("Starting shuttle");
    await app.start();
  }

  async function fullSync() {
    log.info(`Creating app connecting to: ${POSTGRES_URL}, ${REDIS_URL}, ${HUB_HOST}`);
    const app = App.create(POSTGRES_URL, POSTGRES_SCHEMA, REDIS_URL, HUB_HOST, TOTAL_SHARDS, SHARD_INDEX, HUB_SSL);
    
    // First, run backfill if requested
    const shouldBackfill = process.env["ENABLE_BACKFILL"] === "true";
    if (shouldBackfill) {
      log.info("Starting backfill phase...");
      const fids = BACKFILL_FIDS ? BACKFILL_FIDS.split(",").map((fid) => parseInt(fid)) : [];
      log.info(`Backfilling fids: ${fids.length > 0 ? fids : "all FIDs discovered from hub"}`);
      
      const backfillQueue = getQueue(app.redis.client);
      await app.backfillFids(fids, backfillQueue);

      // Start and run the worker to process backfill jobs
      log.info("Processing backfill jobs...");
      const worker = getWorker(app, app.redis.client, log, CONCURRENCY);
      
      // Run worker until all jobs are completed
      await new Promise<void>((resolve) => {
        let completionMarkerSeen = false;
        
        worker.on('completed', (job) => {
          if (job.name === 'completionMarker') {
            log.info("Backfill completion marker reached");
            completionMarkerSeen = true;
          }
        });
        
        worker.on('drained', () => {
          if (completionMarkerSeen) {
            log.info("All backfill jobs completed");
            worker.close();
            resolve();
          }
        });
        
        worker.run();
      });
      
      log.info("Backfill phase completed, starting real-time sync...");
    } else {
      log.info("Backfill disabled, starting real-time sync only...");
    }
    
    // Now start real-time sync
    log.info("Starting real-time shuttle sync");
    await app.start();
  }

  async function backfill() {
    log.info(`Creating app connecting to: ${POSTGRES_URL}, ${REDIS_URL}, ${HUB_HOST}`);
    const app = App.create(POSTGRES_URL, POSTGRES_SCHEMA, REDIS_URL, HUB_HOST, TOTAL_SHARDS, SHARD_INDEX, HUB_SSL);
    const fids = BACKFILL_FIDS ? BACKFILL_FIDS.split(",").map((fid) => parseInt(fid)) : [];
    log.info(`Backfilling fids: ${fids}`);
    const backfillQueue = getQueue(app.redis.client);
    await app.backfillFids(fids, backfillQueue);

    // Start the worker after initiating a backfill
    const worker = getWorker(app, app.redis.client, log, CONCURRENCY);
    await worker.run();
    return;
  }

  async function worker() {
    log.info(`Starting worker connecting to: ${POSTGRES_URL}, ${REDIS_URL}, ${HUB_HOST}`);
    const app = App.create(POSTGRES_URL, POSTGRES_SCHEMA, REDIS_URL, HUB_HOST, TOTAL_SHARDS, SHARD_INDEX, HUB_SSL);
    const worker = getWorker(app, app.redis.client, log, CONCURRENCY);
    await worker.run();
  }

  // for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  //   process.on(signal, async () => {
  //     log.info(`Received ${signal}. Shutting down...`);
  //     (async () => {
  //       await sleep(10_000);
  //       log.info(`Shutdown took longer than 10s to complete. Forcibly terminating.`);
  //       process.exit(1);
  //     })();
  //     await app?.stop();
  //     process.exit(1);
  //   });
  // }

  const program = new Command()
    .name("shuttle")
    .description("Synchronizes a Farcaster Hub with a Postgres database")
    .version(JSON.parse(readFileSync("./package.json").toString()).version);

  program.command("start").description("Starts the shuttle (real-time only)").action(start);
  program.command("full-sync").description("Runs backfill then starts real-time sync").action(fullSync);
  program.command("backfill").description("Queue up backfill for the worker").action(backfill);
  program.command("worker").description("Starts the backfill worker").action(worker);

  program.parse(process.argv);
}

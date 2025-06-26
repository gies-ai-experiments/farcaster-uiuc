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
  MAX_FID,
  POSTGRES_URL,
  POSTGRES_SCHEMA,
  REDIS_URL,
  SHARD_INDEX,
  TOTAL_SHARDS,
  SHARD_INDICES,
  USE_MULTIPLE_SHARDS,
  USE_STREAMING_RPCS_FOR_BACKFILL,
  SUBSCRIBE_RPC_TIMEOUT,
} from "./env";
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
    const reconciler = new MessageReconciliation(
      // biome-ignore lint/style/noNonNullAssertion: client is always initialized
      this.hubSubscribers[0].hubClient!,
      this.db,
      log,
      undefined,
      USE_STREAMING_RPCS_FOR_BACKFILL,
    );
    for (const fid of fids) {
      await reconciler.reconcileMessagesForFid(
        fid,
        async (message, missingInDb, prunedInDb, revokedInDb) => {
          if (missingInDb) {
            await HubEventProcessor.handleMissingMessage(this.db, message, this);
          } else if (prunedInDb || revokedInDb) {
            const messageDesc = prunedInDb ? "pruned" : revokedInDb ? "revoked" : "existing";
            log.info(`Reconciled ${messageDesc} message ${bytesToHexString(message.hash)._unsafeUnwrap()}`);
          }
        },
        async (message, missingInHub) => {
          if (missingInHub) {
            log.info(`Message ${bytesToHexString(message.hash)._unsafeUnwrap()} is missing in the hub`);
          }
        },
      );
    }
  }

  async backfillFids(fids: number[], backfillQueue: Queue) {
    const startedAt = Date.now();
    if (fids.length === 0) {
      let maxFid = MAX_FID ? parseInt(MAX_FID) : undefined;
      if (!maxFid) {
        const getInfoResult = await this.hubSubscribers[0].hubClient?.getInfo(HubInfoRequest.create({}));
        if (getInfoResult?.isErr()) {
          log.error("Failed to get max fid", getInfoResult.error);
          throw getInfoResult.error;
        } else {
          maxFid = getInfoResult?._unsafeUnwrap()?.dbStats?.numFidEvents;
          if (!maxFid) {
            log.error("Failed to get max fid");
            throw new Error("Failed to get max fid");
          }
        }
      }
      log.info(`Queuing up fids upto: ${maxFid}`);
      // create an array of arrays in batches of 100 upto maxFid
      const batchSize = 10;
      const fids = Array.from({ length: Math.ceil(maxFid / batchSize) }, (_, i) => i * batchSize).map((fid) => fid + 1);
      for (const start of fids) {
        const subset = Array.from({ length: batchSize }, (_, i) => start + i);
        await backfillQueue.add("reconcile", { fids: subset });
      }
    } else {
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
      log.info(`Backfilling fids: ${fids.length > 0 ? fids : "all FIDs up to MAX_FID"}`);
      
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

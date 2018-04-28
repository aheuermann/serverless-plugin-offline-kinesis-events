import * as _ from 'lodash'
import * as AWS from 'aws-sdk'
import BB from 'bluebird'
import winston from 'winston'

const MAX_CONSECUTIVE_ERRORS = 10

function createLambdaContext(fun, cb) {
  const functionName = fun.name
  const endTime = new Date().getTime() + (fun.timeout ? fun.timeout * 1000 : 6000)
  // eslint-disable-next-line no-extra-parens
  const done = typeof cb === 'function' ? cb : ((x, y) => x || y)

  return {
    /* Methods */
    done,
    succeed: res => done(null, res),
    fail: err => done(err, null),
    getRemainingTimeInMillis: () => endTime - new Date().getTime(),

    /* Properties */
    functionName,
    memoryLimitInMB: fun.memorySize,
    functionVersion: `offline_functionVersion_for_${functionName}`,
    invokedFunctionArn: `offline_invokedFunctionArn_for_${functionName}`,
    awsRequestId: `offline_awsRequestId_${Math.random().toString(10).slice(2)}`,
    logGroupName: `offline_logGroupName_for_${functionName}`,
    logStreamName: `offline_logStreamName_for_${functionName}`,
    identity: {},
    clientContext: {}
  }
}

function getFunctionOptions(fun, funName, servicePath) {
  // Split handler into method name and path i.e. handler.run
  const handlerPath = fun.handler.split('.')[0]
  const handlerName = fun.handler.split('/').pop().split('.')[1]

  return {
    funName,
    handlerName, // i.e. run
    handlerPath: `${servicePath}/${handlerPath}`,
    funTimeout: (fun.timeout || 30) * 1000,
    babelOptions: ((fun.custom || {}).runtime || {}).babel
  }
}

class ServerlessOfflineKinesisEvents {
  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options

    // Only meaningful for AWS
    this.provider = 'aws'

    // No commands to run
    // TODO(msills): Allow this to be run independently
    this.commands = {}
    // Run automatically as part of the deploy
    this.hooks = {
      'before:offline:start': () => BB.bind(this).then(this.runWatcher)
    }
  }

  static async createRegistry(serverless) {
    // Get a handle on the compiled functions
    const registry = {}
    for (const functionName of _.keys(serverless.service.functions)) {
      const func = serverless.service.functions[functionName]
      // Get the list of streams for the function
      const streamEvents = _.filter(func.events || [], e => 'stream' in e)
      const fun = serverless.service.getFunction(functionName)
      for (const s of streamEvents) {
        const streamName = s.stream.arn.split('/').slice(-1)[0]
        registry[streamName] = registry[streamName] || []
        registry[streamName].push(fun)
      }
    }
    return registry
  }

  static async _repollStreams(kinesis, streamIterators) {
    winston.debug(`Polling Kinesis streams: ${JSON.stringify(_.keys(streamIterators))}`)
    for (const name of _.keys(streamIterators)) {
      if (streamIterators[name] === null) {
        winston.warn(`Iterator for stream '${name}' + is closed`)
      }
    }
    // Get the new values for each stream
    // name -> [fetch result]
    return BB.props(
      _.mapValues(
        streamIterators,
        iter => kinesis.getRecords({
          ShardIterator: iter,
          Limit: 100
        }).promise()))
  }

  static async _runLambdas(serverless, streamResults, registry) {
    // Wait for the functions to execute
    await BB.all(_.chain(streamResults)
      .entries()
      .flatMap(([name, result]) => {
        winston.debug(`Stream '${name}' returned ${result.Records.length} records`)
        if (result.Records.length < 1) {
          return
        }

        // Parse the records
        const records = _.map(result.Records, r => JSON.parse(r.Data.toString()))
        // Apply the functions that use that stream
        return BB.all(registry[name].map(fObj => {
          const context = createLambdaContext(fObj)
          const funOpts = getFunctionOptions(fObj, fObj.handler, serverless.config.servicePath)

          const handler = require(funOpts.handlerPath)[funOpts.handlerName]

          return BB.promisify(handler)({ Records: records }, context)
        }))
      })
      .value())
  }

  async runWatcher() {
    // Create the Kinesis client
    const config = this.serverless.service.custom.offlineKinesisEvents
    const kinesis = new AWS.Kinesis({
      endpoint: `${config.host}:${config.port}`,
      region: config.region,
      apiVersion: '2013-12-02',
      sslEnabled: config.sslEnabled || false
    })

    // Load the registry
    const registry = await ServerlessOfflineKinesisEvents.createRegistry(this.serverless)
    // Get the first shard for every element in the registry
    // Right now, the stream iterators are local to this run. Eventually, we'll persist this somewhere
    let streamIterators = await BB.props(
      _.chain(registry)
      // Grab keys
        .keys()
        // Map to [name, stream description promise]
        .map(name => [name, kinesis.describeStream({ StreamName: name }).promise()])
        // Map to [name, iterator promise]
        .map(([name, descP]) => {
          const iterP = descP.then(desc => kinesis.getShardIterator({
            ShardId: desc.StreamDescription.Shards[0].ShardId,
            ShardIteratorType: 'TRIM_HORIZON',
            StreamName: name
          }).promise())
          return [name, iterP]
        })
        // Back to an object
        .fromPairs()
        // Extract iterators
        .mapValues(iterP => iterP.then(iter => iter.ShardIterator))
        // Grab the value
        .value())

    let consecutiveErrors = 0
    while (true) { // eslint-disable-line no-constant-condition
      winston.debug(`Polling Kinesis streams: ${JSON.stringify(_.keys(registry))}`)
      // Repoll the streams
      const streamResults = await ServerlessOfflineKinesisEvents._repollStreams(kinesis, streamIterators) // eslint-disable-line
      try {
        await ServerlessOfflineKinesisEvents._runLambdas(this.serverless, streamResults, registry) // eslint-disable-line
      } catch (err) {
        consecutiveErrors += 1
        if (consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
          winston.error(`Exceeded maximum number of consecutive errors (${MAX_CONSECUTIVE_ERRORS})`)
          throw err
        }
        winston.error(`Failed to run Lambdas with error ${err.stack}. Continuing`)
      } finally {
        // Update the stream iterators
        streamIterators = _.mapValues(streamResults, result => result.NextShardIterator)
      }

      // Wait a bit
      await BB.delay(config.intervalMillis) // eslint-disable-line no-await-in-loop
    }
  }
}

module.exports = ServerlessOfflineKinesisEvents

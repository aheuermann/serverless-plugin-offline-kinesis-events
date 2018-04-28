'use strict';

var _stringify = require('babel-runtime/core-js/json/stringify');

var _stringify2 = _interopRequireDefault(_stringify);

var _asyncToGenerator2 = require('babel-runtime/helpers/asyncToGenerator');

var _asyncToGenerator3 = _interopRequireDefault(_asyncToGenerator2);

var _lodash = require('lodash');

var _ = _interopRequireWildcard(_lodash);

var _awsSdk = require('aws-sdk');

var AWS = _interopRequireWildcard(_awsSdk);

var _bluebird = require('bluebird');

var _bluebird2 = _interopRequireDefault(_bluebird);

var _winston = require('winston');

var _winston2 = _interopRequireDefault(_winston);

function _interopRequireWildcard(obj) { if (obj && obj.__esModule) { return obj; } else { var newObj = {}; if (obj != null) { for (var key in obj) { if (Object.prototype.hasOwnProperty.call(obj, key)) newObj[key] = obj[key]; } } newObj.default = obj; return newObj; } }

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const MAX_CONSECUTIVE_ERRORS = 10;

function createLambdaContext(fun, cb) {
  const functionName = fun.name;
  const endTime = new Date().getTime() + (fun.timeout ? fun.timeout * 1000 : 6000);
  // eslint-disable-next-line no-extra-parens
  const done = typeof cb === 'function' ? cb : (x, y) => x || y;

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
  };
}

function getFunctionOptions(fun, funName, servicePath) {
  // Split handler into method name and path i.e. handler.run
  const handlerPath = fun.handler.split('.')[0];
  const handlerName = fun.handler.split('/').pop().split('.')[1];

  return {
    funName,
    handlerName, // i.e. run
    handlerPath: `${servicePath}/${handlerPath}`,
    funTimeout: (fun.timeout || 30) * 1000,
    babelOptions: ((fun.custom || {}).runtime || {}).babel
  };
}

class ServerlessOfflineKinesisEvents {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;

    // Only meaningful for AWS
    this.provider = 'aws';

    // No commands to run
    // TODO(msills): Allow this to be run independently
    this.commands = {};
    // Run automatically as part of the deploy
    this.hooks = {
      'before:offline:start': () => _bluebird2.default.bind(this).then(this.runWatcher)
    };
  }

  static createRegistry(serverless) {
    return (0, _asyncToGenerator3.default)(function* () {
      // Get a handle on the compiled functions
      const registry = {};
      for (const functionName of _.keys(serverless.service.functions)) {
        const func = serverless.service.functions[functionName];
        // Get the list of streams for the function
        const streamEvents = _.filter(func.events || [], function (e) {
          return 'stream' in e;
        });
        const fun = serverless.service.getFunction(functionName);
        for (const s of streamEvents) {
          const streamName = s.stream.arn.split('/').slice(-1)[0];
          registry[streamName] = registry[streamName] || [];
          registry[streamName].push(fun);
        }
      }
      return registry;
    })();
  }

  static _repollStreams(kinesis, streamIterators) {
    return (0, _asyncToGenerator3.default)(function* () {
      _winston2.default.debug(`Polling Kinesis streams: ${(0, _stringify2.default)(_.keys(streamIterators))}`);
      for (const name of _.keys(streamIterators)) {
        if (streamIterators[name] === null) {
          _winston2.default.warn(`Iterator for stream '${name}' + is closed`);
        }
      }
      // Get the new values for each stream
      // name -> [fetch result]
      return _bluebird2.default.props(_.mapValues(streamIterators, function (iter) {
        return kinesis.getRecords({
          ShardIterator: iter,
          Limit: 100
        }).promise();
      }));
    })();
  }

  static _runLambdas(serverless, streamResults, registry) {
    return (0, _asyncToGenerator3.default)(function* () {
      // Wait for the functions to execute
      yield _bluebird2.default.all(_.chain(streamResults).entries().flatMap(function ([name, result]) {
        _winston2.default.debug(`Stream '${name}' returned ${result.Records.length} records`);
        if (result.Records.length < 1) {
          return;
        }

        // Parse the records
        const records = _.map(result.Records, function (r) {
          return JSON.parse(r.Data.toString());
        });
        // Apply the functions that use that stream
        return _bluebird2.default.all(registry[name].map(function (fObj) {
          const context = createLambdaContext(fObj);
          const funOpts = getFunctionOptions(fObj, fObj.handler, serverless.config.servicePath);

          const handler = require(funOpts.handlerPath)[funOpts.handlerName];

          return _bluebird2.default.promisify(handler)({ Records: records }, context);
        }));
      }).value());
    })();
  }

  runWatcher() {
    var _this = this;

    return (0, _asyncToGenerator3.default)(function* () {
      // Create the Kinesis client
      const config = _this.serverless.service.custom.offlineKinesisEvents;
      const kinesis = new AWS.Kinesis({
        endpoint: `${config.host}:${config.port}`,
        region: config.region,
        apiVersion: '2013-12-02',
        sslEnabled: config.sslEnabled || false
      });

      // Load the registry
      const registry = yield ServerlessOfflineKinesisEvents.createRegistry(_this.serverless);
      // Get the first shard for every element in the registry
      // Right now, the stream iterators are local to this run. Eventually, we'll persist this somewhere
      let streamIterators = yield _bluebird2.default.props(_.chain(registry)
      // Grab keys
      .keys()
      // Map to [name, stream description promise]
      .map(function (name) {
        return [name, kinesis.describeStream({ StreamName: name }).promise()];
      })
      // Map to [name, iterator promise]
      .map(function ([name, descP]) {
        const iterP = descP.then(function (desc) {
          return kinesis.getShardIterator({
            ShardId: desc.StreamDescription.Shards[0].ShardId,
            ShardIteratorType: 'TRIM_HORIZON',
            StreamName: name
          }).promise();
        });
        return [name, iterP];
      })
      // Back to an object
      .fromPairs()
      // Extract iterators
      .mapValues(function (iterP) {
        return iterP.then(function (iter) {
          return iter.ShardIterator;
        });
      })
      // Grab the value
      .value());

      let consecutiveErrors = 0;
      while (true) {
        // eslint-disable-line no-constant-condition
        _winston2.default.debug(`Polling Kinesis streams: ${(0, _stringify2.default)(_.keys(registry))}`);
        // Repoll the streams
        const streamResults = yield ServerlessOfflineKinesisEvents._repollStreams(kinesis, streamIterators); // eslint-disable-line
        try {
          yield ServerlessOfflineKinesisEvents._runLambdas(_this.serverless, streamResults, registry); // eslint-disable-line
        } catch (err) {
          consecutiveErrors += 1;
          if (consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
            _winston2.default.error(`Exceeded maximum number of consecutive errors (${MAX_CONSECUTIVE_ERRORS})`);
            throw err;
          }
          _winston2.default.error(`Failed to run Lambdas with error ${err.stack}. Continuing`);
        } finally {
          // Update the stream iterators
          streamIterators = _.mapValues(streamResults, function (result) {
            return result.NextShardIterator;
          });
        }

        // Wait a bit
        yield _bluebird2.default.delay(config.intervalMillis); // eslint-disable-line no-await-in-loop
      }
    })();
  }
}

module.exports = ServerlessOfflineKinesisEvents;
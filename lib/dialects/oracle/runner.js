
// Oracle Runner
// ------
'use strict';

module.exports = function(client) {

var _        = require('lodash');
var inherits = require('inherits');

var Promise  = require('../../promise');
var Runner   = require('../../runner');
var helpers  = require('../../helpers');

var OracleQueryStream = require('./oracle-query-stream');

// Inherit from the `Runner` constructor's prototype,
// so we can add the correct `then` method.
function Runner_Oracle() {
  this.client = client;
  Runner.apply(this, arguments);
}
inherits(Runner_Oracle, Runner);

Runner_Oracle.prototype._stream = Promise.method(function (obj, stream, options) {
  var self = this;

  obj.sql = this.client.positionBindings(obj.sql);
  if (this.isDebugging()) this.debug(obj);

  return new Promise(function (resolver, rejecter) {
    stream.on('error', rejecter);
    stream.on('end', resolver);
    var queryStream = new OracleQueryStream(self.connection, obj.sql, obj.bindings, options);
    queryStream.pipe(stream);
  });
});

// Runs the query on the specified connection, providing the bindings
// and any other necessary prep work.
Runner_Oracle.prototype._query = Promise.method(function(obj) {
  var connection = this.connection;

  // convert ? params into positional bindings (:1)
  obj.sql = this.client.positionBindings(obj.sql);
  // convert boolean parameters into 0 or 1
  obj.bindings = this.client.preprocessBindings(obj.bindings) || [];

  if (!obj.sql) throw new Error('The query is empty');
  if (this.isDebugging()) this.debug(obj);
  return new Promise(function(resolver, rejecter) {
    connection.execute(obj.sql, obj.bindings, function(err, response) {
      if (err) return rejecter(err);
      obj.response = response;
      resolver(obj);
    });
  });
});

function convertReturningValuesToResult(response, array) {
  var counter = 0;
  function getNextReturnParameter() {
    var res = response['returnParam' + (counter ? counter : '')];
    counter += 1;
    return res;
  }

  return array.map(function (elem) {
    if (_.isArray(elem)) {
      return array.reduce(function (res, helper) {
        res[helper.columnName] = getNextReturnParameter();
        return res;
      }, {});
    }
    return getNextReturnParameter();
  });
}

// Process the response as returned from the query.
Runner_Oracle.prototype.processResponse = function(obj) {
  var response = obj.response;
  var method   = obj.method;
  if (obj.output) return obj.output.call(this, response);

  switch (method) {
    case 'select':
    case 'pluck':
    case 'first':
      response = helpers.skim(response);
      if (obj.method === 'pluck') response = _.pluck(response, obj.pluck);
      return obj.method === 'first' ? response[0] : response;
    case 'insert':
    case 'del':
    case 'update':
    case 'counter':
      if (obj.returning) {
        var res = convertReturningValuesToResult(response, obj.returning);
        return res;
      }
      return response.updateCount;
    default:
      return response;
  }
};

// Begins a transaction statement on the instance,
// resolving with the connection of the current transaction.
Runner_Oracle.prototype.startTransaction = Promise.method(function() {
  return Promise.bind(this)
    .then(this.ensureConnection)
    .then(function(connection) {
      // disable autocommit to allow correct behavior (default is true)
      connection.setAutoCommit(false);
      this.connection  = connection;
      this.transaction = true;
      return this;
    }).thenReturn(this);
});

function finishOracleTransaction(connection, finishFunc) {
  return new Promise(function (resolver, rejecter) {
    return finishFunc.bind(connection)(function (err, result) {
      if (err) {
        return rejecter;
      }
      // reset AutoCommit back to default to allow recycling in pool
      connection.setAutoCommit(true);
      resolver(result);
    });
  });
}

Runner_Oracle.prototype.commitTransaction = function() {
  return finishOracleTransaction(this.connection, this.connection.commit);
};

Runner_Oracle.prototype.rollbackTransaction = function() {
  return finishOracleTransaction(this.connection, this.connection.rollback);
};

// Assign the newly extended `Runner` constructor to the client object.
client.Runner = Runner_Oracle;

};

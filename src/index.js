var pg = require('pg')
var parseConnectionString = require('pg-connection-string').parse
var findRoot = require('find-root')
var readFileSync = require('fs').readFileSync
var escape = require('./escape')
var inspect = require('util').inspect

var INTERFACE = {
  query: function query () {
    var args = Array.prototype.slice.call(arguments)
    var client = args.shift()
    if (canGetRawSqlFrom(args[0])) {
      args[0] = args[0].__unsafelyGetRawSql()
    }
    if (Array.isArray(args[0])) args = sqlTemplate(client, args)
    var sql = args[0]
    var params = args[1]

    var query
    var cancelled

    var stack = (new Error()).stack

    var promise = new Promise(function doQuery (resolve, reject) {
      if (cancelled) return reject(new Cancel())
      query = client.query(sql, params, function onResult (err, result) {
        if (cancelled) {
          reject(new Cancel())
        } else if (err) {
          reject(new SqlError(sql, params, stack, err))
        } else {
          resolve(result)
        }
      })
    })

    promise.cancel = function cancel () {
      cancelled = true
      if (client.activeQuery === query) {
        return INTERFACE.query(client, 'SELECT pg_cancel_backend($1)', [client.processID])
      }
    }

    return promise
  },
  rows: function rows () {
    return thenWithCancel(INTERFACE.query.apply(null, arguments),
      function (result) { return result.rows }
    )
  },
  row: function row () {
    return thenWithCancel(INTERFACE.query.apply(null, arguments),
      function (result) { return result.rows[0] }
    )
  },
  value: function value () {
    return thenWithCancel(INTERFACE.row.apply(null, arguments),
      function (row) { return row && row[ Object.keys(row)[0] ] }
    )
  },
  column: function column () {
    return thenWithCancel(INTERFACE.query.apply(null, arguments),
      function (result) {
        var col = result.rows[0] && Object.keys(result.rows[0])[0]
        return result.rows.map(
          function (row) { return row[col] }
        )
      }
    )
  }
}

function Cancel () {
  this.name = 'Cancel'
  this.message = 'Query cancelled'
  this.stack = (new Error()).stack
}
Cancel.prototype = Object.create(Error.prototype)
Cancel.prototype.constructor = Cancel

function SqlError (sql, params, stack, pgErr) {
  this.name = 'SqlError'
  this.message = (
    'SQL Error: ' + pgErr.message + '\n' +
    sql +
    (params && params.length
      ? '\nQuery parameters:' + stringifyParameters(params)
      : '')
  )
  this.stack = this.message + '\n' + stack.replace(/^.+\n/, '')
}
SqlError.prototype = Object.create(Error.prototype)
SqlError.prototype.constructor = SqlError

function stringifyParameters (params) {
  return params.map(function (p, i) {
    return '\n  $' + (i + 1) + ': ' + typeof p + ' ' + inspect(p)
  }).join('')
}

function thenWithCancel (promise, fn) {
  var newPromise = promise.then(fn)
  newPromise.cancel = promise.cancel.bind(promise)
  return newPromise
}

function sqlTemplate (client, values) {
  var strings = values.shift()
  var stringsLength = strings.length
  var valuesLength = values.length
  var maxLength = Math.max(stringsLength, valuesLength)

  var sql = ''
  var params = []
  var val
  for (var i = 0; i < maxLength; i++) {
    if (i < stringsLength) {
      val = strings[i]
      if (canGetRawSqlFrom(val)) {
        sql += val.__unsafelyGetRawSql(client)
      } else {
        sql += val
      }
    }
    if (i < valuesLength) {
      val = values[i]
      if (canGetRawSqlFrom(val)) {
        sql += val.__unsafelyGetRawSql(client)
      } else {
        sql += '$' + params.push(val)
      }
    }
  }

  return [sql, params]
}

function templateIdentifier (value) {
  value = escape.identifier(value)
  return {
    __unsafelyGetRawSql: function __unsafelyGetRawSql () {
      return value
    }
  }
}

function templateIdentifiers (identifiers, separator) {
  let value = escape.identifiers(identifiers, separator)
  return {
    __unsafelyGetRawSql: function __unsafelyGetRawSql () {
      return value
    }
  }
}

function templateLiteral (value) {
  value = escape.literal(value)
  return {
    __unsafelyGetRawSql: function __unsafelyGetRawSql () {
      return value
    }
  }
}

function templateLiterals (literals, separator) {
  let value = escape.literals(literals, separator)
  return {
    __unsafelyGetRawSql: function __unsafelyGetRawSql () {
      return value
    }
  }
}

function templateItems (items, separator) {
  return {
    __unsafelyGetRawSql: function __unsafelyGetRawSql (client) {
      return items.map((v) =>
        canGetRawSqlFrom(v)
        ? v.__unsafelyGetRawSql(client)
        : escape.literal(v)
      ).join(separator || ', ')
    }
  }
}

function canGetRawSqlFrom (v) {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.__unsafelyGetRawSql === 'function' &&
    Object.keys(v).length === 1
  )
}

function withConnection (server, work, cancellable) {
  var client
  var done
  var cancelled
  var activeWork
  var finishCancel

  var promise = (
    connect(server)
      .then(function onConnect (conn) {
        client = conn[0]
        done = conn[1]

        if (cancelled) {
          done()
          setImmediate(finishCancel)
          throw new Cancel()
        }

        activeWork = work(client)
        return activeWork
      })
      .then(function onResult (result) {
        done()

        if (cancelled) {
          setImmediate(finishCancel)
          throw new Cancel()
        }

        return result
      })
      .catch(function onError (err) {
        if (done) {
          if (err instanceof Error && err.ABORT_CONNECTION) {
            // this is a really bad one, remove the connection from the pool
            done(err)
          } else {
            done()
          }
        }

        if (cancelled) {
          setImmediate(finishCancel)
          throw new Cancel()
        }

        throw err
      })
  )

  if (cancellable) {
    promise.cancel = function () {
      cancelled = true
      if (activeWork !== null && typeof activeWork === 'object' && typeof activeWork.cancel === 'function') {
        return activeWork.cancel()
      } else {
        return new Promise(function (resolve) { finishCancel = resolve })
      }
    }
  }

  return promise
}

function connect (server) {
  if (typeof server === 'string') {
    server = parseConnectionString(server)
  } else if (typeof server === 'undefined') {
    server = {}
  }

  server.poolSize = server.poolSize || process.env.PG_POOL_SIZE
  server.poolIdleTimeout = (
    server.poolIdleTimeout ||
    process.env.PG_IDLE_TIMEOUT ||
    (process.env.NODE_ENV === 'test' && 1)
  )
  server.reapIntervalMillis = (
    server.reapIntervalMillis ||
    process.env.PG_REAP_INTERVAL ||
    (process.env.NODE_ENV === 'test' && 50)
  )
  server.application_name = (
    server.application_name ||
    process.env.APPLICATION_NAME ||
    getApplicationName()
  )

  return new Promise(function doConnection (resolve, reject) {
    return pg.connect(server, function onConnect (err, client, done) {
      if (err) {
        reject(err)
      } else {
        resolve([client, done])
      }
    })
  })
}

function getApplicationName () {
  var path = findRoot(process.argv[1] || process.cwd()) + '/package.json'
  var pkg = JSON.parse(readFileSync(path, 'utf8'))
  return pkg.name
}

function configure (server) {
  var iface = {
    connection: function connection (work) {
      return withConnection(server, function doConnection (client) {
        return work(Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
          i[methodName] = INTERFACE[methodName].bind(null, client)
          return i
        }, {}))
      })
    },
    transaction: function transaction (work) {
      return iface.connection(function doTransaction (connIface) {
        var result
        var inTransaction

        return (
          connIface.query('begin')
            .then(function onBegin () {
              inTransaction = true
              return work(connIface)
            })
            .then(function onResult (_result) {
              result = _result
              return connIface.query('commit')
            })
            .then(function onCommit () {
              return result
            })
            .catch(function onError (err) {
              if (!inTransaction) throw err

              return (
                connIface.query('rollback')
                  .catch(function onRollbackFail (rollbackErr) {
                    err = (err instanceof Error ? err.message + '\n' + err.stack : err)
                    rollbackErr = (rollbackErr instanceof Error ? rollbackErr.message + '\n' + rollbackErr.stack : rollbackErr)
                    var bigErr = new Error(
                      'Failed to execute rollback after error\n' +
                      err + '\n\n' + rollbackErr
                    )
                    bigErr.ABORT_CONNECTION = true
                    throw bigErr
                  })
                  .then(function onRollback (r) {
                    throw err
                  })
              )
            })
        )
      })
    }
  }

  iface.template = function sqlTemplate (client) {
    var values = Array.prototype.slice.call(arguments)
    var strings = values.shift()
    var stringsLength = strings.length
    var valuesLength = values.length
    var maxLength = Math.max(stringsLength, valuesLength)

    return {
      __unsafelyGetRawSql (client) {
        var sql = ''
        for (var i = 0; i < maxLength; i++) {
          if (i < stringsLength) {
            sql += strings[i]
          }
          if (i < valuesLength) {
            if (canGetRawSqlFrom(values[i])) {
              sql += values[i].__unsafelyGetRawSql(client)
            } else {
              sql += iface.escapeLiteral(values[i])
            }
          }
        }
        return sql
      }
    }
  }
  iface.escape = escape.literal
  iface.escapeLiteral = escape.literal
  iface.escapeLiterals = escape.literals
  iface.escapeIdentifier = escape.identifier
  iface.escapeIdentifiers = escape.identifiers

  iface.items = templateItems
  iface.identifier = templateIdentifier
  iface.identifiers = templateIdentifiers
  iface.literal = templateLiteral
  iface.literals = templateLiterals

  iface = Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
    i[methodName] = function (sql, params) {
      var args = Array.prototype.slice.call(arguments)
      return withConnection(server, function onConnect (client) {
        return INTERFACE[methodName].apply(null, [client].concat(args))
      }, true)
    }
    i[methodName].displayName = methodName
    return i
  }, iface)

  return iface
}

module.exports = configure(process.env.DATABASE_URL)
module.exports.configure = configure
module.exports.Cancel = Cancel

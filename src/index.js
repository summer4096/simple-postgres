var pg = require('pg')
var parseConnectionString = require('pg-connection-string').parse
var escape = require('./escape')

var INTERFACE = {
  query () {
    var args = Array.prototype.slice.call(arguments)
    var client = args.shift()
    if (Array.isArray(args[0])) args = sqlTemplate(client, args)
    var sql = args[0]
    var params = args[1]

    return new Promise(function doQuery (resolve, reject) {
      client.query(sql, params, function onResult (err, result) {
        if (err) {
          reject(err)
        } else {
          resolve(result)
        }
      })
    })
  },
  rows () {
    return INTERFACE.query.apply(null, arguments).then(
      function (result) { return result.rows }
    )
  },
  row () {
    return INTERFACE.query.apply(null, arguments).then(
      function (result) { return result.rows[0] }
    )
  },
  value () {
    return INTERFACE.row.apply(null, arguments).then(
      function (row) { return row && row[ Object.keys(row)[0] ] }
    )
  },
  column () {
    return INTERFACE.query.apply(null, arguments).then(
      function (result) {
        var col = result.rows[0] && Object.keys(result.rows[0])[0]
        return result.rows.map(
          function (row) { return row[col] }
        )
      }
    )
  }
}

function sqlTemplate (client, values) {
  var strings = values.shift()
  var stringsLength = strings.length
  var valuesLength = values.length
  var maxLength = Math.max(stringsLength, valuesLength)

  var sql = ''
  var params = []
  for (var i = 0; i < maxLength; i++) {
    if (i < stringsLength) {
      sql += strings[i]
    }
    if (i < valuesLength) {
      var val = values[i]
      if (typeof val === 'object' && val !== null && typeof val.__unsafelyGetRawSql === 'function') {
        sql += val.__unsafelyGetRawSql(client)
      } else {
        sql += '$' + params.push(values[i])
      }
    }
  }

  return [sql, params]
}

function templateIdentifier (value) {
  value = escape.identifier(value)
  return {
    __unsafelyGetRawSql () {
      return value
    }
  }
}

function templateLiteral (value) {
  value = escape.literal(value)
  return {
    __unsafelyGetRawSql () {
      return value
    }
  }
}

function withConnection (server, work) {
  var client
  var done
  return (
    connect(server)
      .then(function onConnect (conn) {
        client = conn[0]
        done = conn[1]
        return work(client)
      })
      .then(function onResult (result) {
        done()
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
        if (done) done()
        throw err
      })
  )
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

function configure (server) {
  var iface = {
    transaction (work) {
      var trxIface
      return withConnection(server, function doTransaction (client) {
        trxIface = Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
          i[methodName] = INTERFACE[methodName].bind(null, client)
          return i
        }, {})

        var result
        var inTransaction

        return (
          trxIface.query('begin')
            .then(function onBegin () {
              inTransaction = true
              return work(trxIface)
            })
            .then(function onResult (_result) {
              result = _result
              return trxIface.query('commit')
            })
            .then(function onCommit () {
              return result
            })
            .catch(function onError (err) {
              if (!inTransaction) throw err

              return (
                trxIface.query('rollback')
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

  iface.identifier = templateIdentifier
  iface.literal = templateLiteral
  iface.escape = escape.literal
  iface.escapeIdentifier = escape.identifier

  iface = Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
    i[methodName] = function (sql, params) {
      var args = Array.prototype.slice.call(arguments)
      return withConnection(server, function onConnect (client) {
        return INTERFACE[methodName].apply(null, [client].concat(args))
      })
    }
    i[methodName].displayName = methodName
    return i
  }, iface)

  return iface
}

var main = configure(process.env.DATABASE_URL)
main.configure = configure

module.exports = main

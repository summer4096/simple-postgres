const { Pool } = require('pg')
const parseConnectionString = require('pg-connection-string').parse
const parseUrl = require('url').parse
const findRoot = require('find-root')
const readFileSync = require('fs').readFileSync
const escape = require('./escape')
const inspect = require('util').inspect

function DO_NOTHING () {}

const INTERFACE = {
  query (client, ...args) {
    if (canGetRawSqlFrom(args[0])) {
      args[0] = args[0].__unsafelyGetRawSql()
    }
    if (Array.isArray(args[0])) args = sqlTemplate(client, args)
    let sql = args[0]
    let params = args[1]
    let query
    let cancelled
    let stack = (new Error()).stack

    let promise = new Promise(function doQuery (resolve, reject) {
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
  rows (...args) {
    return thenWithCancel(INTERFACE.query(...args),
      function (result) { return result.rows }
    )
  },
  row (...args) {
    return thenWithCancel(INTERFACE.query(...args),
      function (result) { return result.rows[0] }
    )
  },
  value (...args) {
    return thenWithCancel(INTERFACE.row(...args),
      function (row) { return row && row[ Object.keys(row)[0] ] }
    )
  },
  column (...args) {
    return thenWithCancel(INTERFACE.query(...args),
      function (result) {
        let col = result.rows[0] && Object.keys(result.rows[0])[0]
        return result.rows.map(
          function (row) { return row[col] }
        )
      }
    )
  }
}

class Cancel extends Error {
  constructor () {
    super()
    this.name = 'Cancel'
    this.message = 'Query cancelled'
  }
}

class SqlError extends Error {
  constructor (sql, params, stack, pgError) {
    super()
    this.name = 'SqlError'
    this.message = (
      'SQL Error: ' + pgError.message + '\n' +
      sql +
      (params && params.length
        ? '\nQuery parameters:' + stringifyParameters(params)
        : ''))
    this.stack = this.message + '\n' + stack.replace(/^.+\n/, '')
  }
}

function stringifyParameters (params) {
  return params.map(function (p, i) {
    return '\n  $' + (i + 1) + ': ' + typeof p + ' ' + inspect(p)
  }).join('')
}

function thenWithCancel (promise, fn) {
  let newPromise = promise.then(fn)
  newPromise.cancel = promise.cancel.bind(promise)
  return newPromise
}

function sqlTemplate (client, values) {
  let strings = values.shift()
  let stringsLength = strings.length
  let valuesLength = values.length
  let maxLength = Math.max(stringsLength, valuesLength)
  let sql = ''
  let params = []
  let val
  for (let i = 0; i < maxLength; i++) {
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
    __unsafelyGetRawSql () {
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

function withConnection (connection, work, cancellable) {
  let client
  let done
  let cancelled
  let activeWork
  let finishCancel

  let promise =
    connection.then(function onConnect (conn) {
      client = conn[0]
      done = conn[1]

      if (cancelled) {
        setImmediate(finishCancel)
        throw new Cancel()
      }

      activeWork = work(client)
      return activeWork
    }).then(function onResult (result) {
      if (cancelled) {
        setImmediate(finishCancel)
        throw new Cancel()
      }

      done()

      return result
    }).catch(function onError (err) {
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

function getApplicationName () {
  let path = findRoot(process.argv[1] || process.cwd()) + '/package.json'
  let pkg = JSON.parse(readFileSync(path, 'utf8'))
  return pkg.name
}

function configure (server) {
  if (typeof server === 'string') {
    server = Object.assign(
      parseConnectionString(server),
      parseUrl(server, true).query // add query parameters
    )
  } else if (typeof server === 'undefined') {
    server = {}
  }

  for (let v of ['ssl', 'keepAlive', 'binary']) {
    if (typeof server[v] === 'string') {
      server[v] = server[v] !== 'false'
    }
  }
  for (let v of ['idleTimeoutMillis', 'poolSize', 'max', 'statement_timeout']) {
    if (typeof server[v] === 'string') {
      server[v] = server[v] === 'false' ? false : Number(server[v])
    }
  }

  if ((server.poolSize || process.env.PG_POOL_SIZE) && typeof server.max === 'undefined') {
    server.max = server.poolSize || process.env.PG_POOL_SIZE
  }
  server.idleTimeoutMillis = (
    server.idleTimeoutMillis ||
    process.env.PG_IDLE_TIMEOUT ||
    (process.env.NODE_ENV === 'test' && 1)
  )
  server.application_name = (
    server.application_name ||
    process.env.APPLICATION_NAME ||
    getApplicationName()
  )

  let handleError = server.errorHandler || DO_NOTHING
  function setErrorHandler (handler) {
    handleError = handler || DO_NOTHING
  }

  if (server.debug_postgres || process.env.DEBUG_POSTGRES) {
    const defaultLog = server.log || DO_NOTHING
    server.log = function debugLog (...args) {
      console.debug('simple-postgres debug', ...args)
      defaultLog(...args)
    }
  }

  let _pool
  function pool () {
    if (!_pool) {
      _pool = new Promise(resolve => {
        const p = new Pool(server)
        p.on('error', (...args) => handleError(...args))
        resolve(p)
      })
    }
    return _pool
  }

  function connect () {
    // TODO: allow returning just the client, not the tuple of client + release fn
    return pool().then(p => p.connect()).then(client => {
      if (typeof client.__simplePostgresOnError === 'undefined') {
        client.__simplePostgresOnError = true
        client.on('error', (...args) => handleError(...args))
      }
      return [client, client.release.bind(client)]
    })
  }

  let iface = {
    connection (work) {
      return withConnection(connect(), function doConnection (client) {
        return work(Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
          i[methodName] = INTERFACE[methodName].bind(null, client)
          i[methodName].displayName = methodName + '_in_connection'
          return i
        }, {}))
      })
    },
    transaction (work) {
      return iface.connection(function doTransaction (connIface) {
        let result
        let inTransaction

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
                    let bigErr = new Error(
                      'Failed to execute rollback after error\n' +
                      err + '\n\n' + rollbackErr
                    )
                    bigErr.ABORT_CONNECTION = true
                    throw bigErr
                  })
                  .then(function onRollback () {
                    throw err
                  })
              )
            })
        )
      })
    }
  }

  iface.template = function sqlTemplate (strings, ...values) {
    let stringsLength = strings.length
    let valuesLength = values.length
    let maxLength = Math.max(stringsLength, valuesLength)

    return {
      __unsafelyGetRawSql (client) {
        let sql = ''
        for (let i = 0; i < maxLength; i++) {
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
  iface.pool = pool
  iface.setErrorHandler = setErrorHandler

  iface = Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
    i[methodName] = function (...args) {
      return withConnection(connect(), function onConnect (client) {
        return INTERFACE[methodName](client, ...args)
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

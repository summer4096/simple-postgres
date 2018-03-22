const pg = require('pg')
const parseConnectionString = require('pg-connection-string').parse
const findRoot = require('find-root')
const readFileSync = require('fs').readFileSync
const escape = require('./escape')
const inspect = require('util').inspect

const INTERFACE = {
  query (client, ...rest) {
    let [sql, params] = Array.isArray(rest[0]) ? sqlTemplate(client, rest) : rest
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
  for (let i = 0; i < maxLength; i++) {
    if (i < stringsLength) {
      sql += strings[i]
    }
    if (i < valuesLength) {
      let val = values[i]
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
    __unsafelyGetRawSql: function __unsafelyGetRawSql () {
      return value
    }
  }
}

function templateIdentifiers (identifiers, separator) {
  let value = escape.identifiers(identifiers, separator)
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

function templateLiterals (literals, separator) {
  let value = escape.literals(literals, separator)
  return {
    __unsafelyGetRawSql () {
      return value
    }
  }
}

function withConnection (server, work, cancellable) {
  let client
  let done
  let cancelled
  let activeWork
  let finishCancel

  let promise = (
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
  let path = findRoot(process.argv[1] || process.cwd()) + '/package.json'
  let pkg = JSON.parse(readFileSync(path, 'utf8'))
  return pkg.name
}

function configure (server) {
  let iface = {
    connection (work) {
      return withConnection(server, function doConnection (client) {
        return work(Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
          i[methodName] = INTERFACE[methodName].bind(null, client)
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
                  .then(function onRollback (r) {
                    throw err
                  })
              )
            })
        )
      })
    }
  }

  iface.escape = escape.literal
  iface.escapeLiteral = escape.literal
  iface.escapeLiterals = escape.literals
  iface.escapeIdentifier = escape.identifier
  iface.escapeIdentifiers = escape.identifiers

  iface.identifier = templateIdentifier
  iface.identifiers = templateIdentifiers
  iface.literal = templateLiteral
  iface.literals = templateLiterals

  iface = Object.keys(INTERFACE).reduce(function linkInterface (i, methodName) {
    i[methodName] = function (sql, params, ...rest) {
      return withConnection(server, function onConnect (client) {
        return INTERFACE[methodName](client, sql, params, ...rest)
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
module.exports.SqlError = SqlError


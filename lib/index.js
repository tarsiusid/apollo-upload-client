const { ApolloLink, Observable } = require('apollo-link')
const {
  selectURI,
  selectHttpOptionsAndBody,
  fallbackHttpConfig,
  serializeFetchParameter,
  createSignalIfSupported,
  parseAndCheckHttpResponse
} = require('apollo-link-http-common')
const { extractFiles, ReactNativeFile } = require('extract-files')

/**
 * A React Native [`File`](https://developer.mozilla.org/docs/web/api/file)
 * substitute.
 * @kind typedef
 * @name ReactNativeFileSubstitute
 * @type {Object}
 * @see [`extract-files` docs](https://github.com/jaydenseric/extract-files#type-reactnativefilesubstitute).
 * @see [React Native `FormData` polyfill source](https://github.com/facebook/react-native/blob/v0.45.1/Libraries/Network/FormData.js#L34).
 * @prop {String} uri Filesystem path.
 * @prop {String} [name] File name.
 * @prop {String} [type] File content type.
 * @example <caption>A camera roll file.</caption>
 * ```js
 * {
 *   uri: uriFromCameraRoll,
 *   name: 'a.jpg',
 *   type: 'image/jpeg'
 * }
 * ```
 */

/**
 * Used to mark a
 * [React Native `File` substitute]{@link ReactNativeFileSubstitute}.
 * It’s too risky to assume all objects with `uri`, `type` and `name` properties
 * are files to extract. Re-exported from [`extract-files`](https://npm.im/extract-files)
 * for convenience.
 * @kind class
 * @name ReactNativeFile
 * @param {ReactNativeFileSubstitute} file A React Native [`File`](https://developer.mozilla.org/docs/web/api/file) substitute.
 * @example <caption>A React Native file that can be used in query or mutation variables.</caption>
 * ```js
 * const { ReactNativeFile } = require('apollo-upload-client')
 *
 * const file = new ReactNativeFile({
 *   uri: uriFromCameraRoll,
 *   name: 'a.jpg',
 *   type: 'image/jpeg'
 * })
 * ```
 */
exports.ReactNativeFile = ReactNativeFile

/**
 * GraphQL request `fetch` options.
 * @kind typedef
 * @name FetchOptions
 * @type {Object}
 * @see [Polyfillable fetch options](https://github.github.io/fetch#options).
 * @prop {Object} headers HTTP request headers.
 * @prop {string} [credentials] Authentication credentials mode.
 */

/**
 * Creates a terminating [Apollo Link](https://apollographql.com/docs/link)
 * capable of file uploads. Options match [`createHttpLink`](https://apollographql.com/docs/link/links/http#options).
 * @see [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec).
 * @see [apollo-link on GitHub](https://github.com/apollographql/apollo-link).
 * @kind function
 * @name createUploadLink
 * @param {Object} options Options.
 * @param {string} [options.uri=/graphql] GraphQL endpoint URI.
 * @param {function} [options.fetch] [`fetch`](https://fetch.spec.whatwg.org) implementation to use, defaulting to the `fetch` global.
 * @param {FetchOptions} [options.fetchOptions] `fetch` options; overridden by upload requirements.
 * @param {string} [options.credentials] Overrides `options.fetchOptions.credentials`.
 * @param {Object} [options.headers] Merges with and overrides `options.fetchOptions.headers`.
 * @param {boolean} [options.includeExtensions=false] Toggles sending `extensions` fields to the GraphQL server.
 * @returns {ApolloLink} A terminating [Apollo Link](https://apollographql.com/docs/link) capable of file uploads.
 * @example <caption>A basic Apollo Client setup.</caption>
 * ```js
 * const { ApolloClient } = require('apollo-client')
 * const { InMemoryCache } = require('apollo-cache-inmemory')
 * const { createUploadLink } = require('apollo-upload-client')
 *
 * const client = new ApolloClient({
 *   cache: new InMemoryCache(),
 *   link: createUploadLink()
 * })
 * ```
 */
exports.createUploadLink = ({
  uri: fetchUri = '/graphql',
  fetch: linkFetch = fetch,
  fetchOptions,
  credentials,
  headers,
  includeExtensions
} = {}) => {
  const linkConfig = {
    http: { includeExtensions },
    options: fetchOptions,
    credentials,
    headers
  }

  return new ApolloLink(operation => {
    const uri = selectURI(operation, fetchUri)
    const context = operation.getContext()
    const contextConfig = {
      http: context.http,
      options: context.fetchOptions,
      credentials: context.credentials,
      headers: context.headers
    }

    const { options, body } = selectHttpOptionsAndBody(
      operation,
      fallbackHttpConfig,
      linkConfig,
      contextConfig
    )

    const files = extractFiles(body)
    const payload = serializeFetchParameter(body, 'Payload')

    if (files.length) {
      // Automatically set by fetch when the body is a FormData instance.
      delete options.headers['content-type']

      // GraphQL multipart request spec:
      // https://github.com/jaydenseric/graphql-multipart-request-spec
      options.body = new FormData()
      options.body.append('operations', payload)
      options.body.append(
        'map',
        JSON.stringify(
          files.reduce((map, { path }, index) => {
            map[`${index}`] = [path]
            return map
          }, {})
        )
      )
      files.forEach(({ file }, index) =>
        options.body.append(index, file, file.name)
      )
    } else options.body = payload

    return new Observable(observer => {
      // Allow aborting fetch, if supported.
      const { controller, signal } = createSignalIfSupported()
      if (controller) options.signal = signal

      // If this is a query, let's reassemble a raw query instead of using variables.
      let body = JSON.parse(options.body);
      if (body.query) {
        let rawQuery = body.query.split('{').splice(1).join('{').split('}').slice(0,-1).join('}');
        let keys = Object.keys(body.variables);
        for (const i in keys) {
          let val;
          if (keys[i].toLowerCase() === 'id' || typeof body.variables[keys[i]] === 'number') {
            val = body.variables[keys[i]];
          } else {
            // Otherwise, it must be a string
            val = '\'' + body.variables[keys[i]] + '\'';
          }
          const r = RegExp('\\$' + keys[i], 'i')
          rawQuery = rawQuery.replace(r, body.variables[keys[i]]);
        }
        rawQuery = rawQuery.replace(/\n/g, '');
        rawQuery = ' query { ' + rawQuery + ' } ';
        body = {
          operationName : body.operation,
          query : rawQuery,
          variables: null,
        }
        options.body = JSON.stringify(body);
      }

      linkFetch(uri, options)
        .then(response => {
          // Forward the response on the context.
          operation.setContext({ response })
          return response
        })
        .then(parseAndCheckHttpResponse(operation))
        .then(result => {
          observer.next(result)
          observer.complete()
        })
        .catch(error => {
          if (error.name === 'AbortError')
            // Fetch was aborted.
            return

          if (error.result && error.result.errors && error.result.data)
            // There is a GraphQL result to forward.
            observer.next(error.result)

          observer.error(error)
        })

      // Cleanup function.
      return () => {
        // Abort fetch.
        if (controller) controller.abort()
      }
    })
  })
}

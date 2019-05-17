import { useEffect, useState, useCallback } from 'react'
import {
  camelCase,
  compose,
  has,
  head,
  isPlainObject,
  isFunction,
  keys,
  merge,
} from 'lodash/fp'
import { set as setCookie } from 'es-cookie'
import Prismic from 'prismic-javascript'
import uuidv5 from 'uuid/v5'
import md5 from 'md5'
import traverse from 'traverse'

import { documentToNodes } from './documentToNodes'
import {
  normalizeImageField,
  normalizeLinkField,
  normalizeSlicesField,
  normalizeStructuredTextField,
} from './normalizers/browser'

const seedConstant = `638f7a53-c567-4eca-8fc1-b23efb1cfb2b`
const createNodeId = id =>
  uuidv5(id, uuidv5('gatsby-source-prismic', seedConstant))
const createContentDigest = obj => md5(JSON.stringify(obj))

// Returns an object containing normalized Prismic preview data directly from
// the Prismic API. The normalized data object's shape is identical to the shape
// created by Gatsby at build time minus image processing due to running in the
// browser. Instead, image nodes return their source URL.
export const usePrismicPreview = (location, overrides) => {
  if (!location) throw new Error('Invalid location object!. Check hook call.')
  if (!overrides.linkResolver || !isFunction(overrides.linkResolver))
    throw new Error('Invalid linkResolver!')
  if (overrides.pathResolver && !isFunction(overrides.pathResolver))
    throw new Error('pathResolver is not a function!')

  const [state, setState] = useState({
    previewData: null,
    path: null,
    isInvalid: false,
  })

  const configOptions = window.___prismicPluginOptions___
  const pluginOptions = { ...configOptions, ...overrides }

  const {
    fetchLinks,
    accessToken,
    repositoryName,
    pathResolver,
    linkResolver,
  } = pluginOptions
  const apiEndpoint = `https://${repositoryName}.cdn.prismic.io/api/v2`

  // Fetches raw preview data directly from Prismic via ID.
  const fetchRawPreviewData = useCallback(
    async id => {
      const api = await Prismic.getApi(apiEndpoint, { accessToken })

      return await api.getByID(id, { fetchLinks })
    },
    [accessToken, apiEndpoint, fetchLinks],
  )

  // Fetches and parses the JSON file of the typePaths we write at build time.
  const fetchTypePaths = useCallback(async () => {
    const req = await fetch(
      `/prismic-typepaths---${pluginOptions.repositoryName}-.json`,
      { headers: { 'Content-Type': 'application/json' } },
    )

    return await req.json()
  }, [pluginOptions])

  // Normalizes preview data using browser-compatible normalize functions.
  const normalizePreviewData = useCallback(
    async rawPreviewData => {
      const typePaths = await fetchTypePaths()
      console.log(typePaths)

      const nodeStore = new Map()
      const createNode = node => nodeStore.set(node.id, node)
      const hasNodeById = id => nodeStore.has(id)
      const getNodeById = id => nodeStore.get(id)

      const rootNodeId = await documentToNodes(rawPreviewData, {
        typePaths,
        createNode,
        createNodeId,
        createContentDigest,
        hasNodeById,
        getNodeById,
        pluginOptions,
        normalizeImageField,
        normalizeLinkField,
        normalizeSlicesField,
        normalizeStructuredTextField,
      })

      const rootNode = nodeStore.get(rootNodeId)

      const prefixedType = camelCase(rootNode.internal.type)

      return {
        [prefixedType]: rootNode,
      }
    },
    [fetchTypePaths, pluginOptions],
  )

  // Fetches and normalizes preview data from Prismic.
  const asyncEffect = useCallback(async () => {
    const searchParams = new URLSearchParams(location.search)
    const token = searchParams.get('token')
    const docID = searchParams.get('documentId')

    // Required to send preview cookie on all API requests on future routes.
    setCookie(Prismic.previewCookie, token)

    const rawPreviewData = await fetchRawPreviewData(docID)
    const path = pathResolver
      ? pathResolver(rawPreviewData)
      : linkResolver(rawPreviewData)
    const previewData = await normalizePreviewData(rawPreviewData)

    setState({
      ...state,
      path,
      previewData,
    })
  }, [
    fetchRawPreviewData,
    linkResolver,
    location.search,
    normalizePreviewData,
    pathResolver,
    state,
  ])

  useEffect(() => {
    asyncEffect()
  }, [])

  return state
}

// Helper function that merges Gatsby's static data with normalized preview data.
// If the custom types are the same, deep merge with static data.
// If the custom types are different, deeply replace any document in the static
// data that matches the preview document's ID.
export const mergePrismicPreviewData = ({ staticData, previewData }) => {
  if (!staticData) return undefined
  if (!previewData) return staticData

  const traversalMerge = ({ staticData, previewData, key }) => {
    const { data: previewDocData, id: previewId } = previewData[key]

    function handleNode(node) {
      if (isPlainObject(node) && has('id', node) && node.id === previewId) {
        this.update(
          merge(node, {
            data: previewDocData,
          }),
        )
      }
    }

    return traverse(staticData).map(handleNode)
  }

  const mergeStaticData = (staticData, previewData) => {
    const previewKey = compose(
      head,
      keys,
    )(previewData)

    if (!has(previewKey, staticData))
      return traversalMerge({ staticData, previewData, key: previewKey })

    return merge(staticData, previewData)
  }

  return mergeStaticData(staticData, previewData)
}

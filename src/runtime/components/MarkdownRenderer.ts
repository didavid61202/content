import { h, resolveComponent, Text, defineComponent, toRefs } from 'vue'
import destr from 'destr'
import { pascalCase } from 'scule'
import { find, html } from 'property-information'
// eslint-disable-next-line import/no-named-as-default
import htmlTags from 'html-tags'
import type { VNode, ConcreteComponent } from 'vue'
import { useRuntimeConfig, useRoute } from '#app'
import type { MarkdownNode, ParsedContentMeta } from '../types'

type CreateElement = typeof h
type ContentVNode = VNode | string

/**
 *  Default slot name
 */
const DEFAULT_SLOT = 'default'

const rxOn = /^@|^v-on:/
const rxBind = /^:|^v-bind:/
const rxModel = /^v-model/
const nativeInputs = ['select', 'textarea', 'input']

export default defineComponent({
  name: 'ContentRendererMarkdown',
  props: {
    /**
     * Content to render
     */
    value: {
      type: Object,
      required: true
    },
    /**
     * Render only the excerpt
     */
    excerpt: {
      type: Boolean,
      default: false
    },
    /**
     * Root tag to use for rendering
     */
    tag: {
      type: String,
      default: 'div'
    }
  },
  setup (props) {
    const { content: { tags = {} } } = useRuntimeConfig().public

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tag: _t, value: _d, ...contentProps } = toRefs(props)

    return {
      tags,
      contentProps
    }
  },
  render (ctx) {
    const { tags, tag, value, contentProps } = ctx

    if (!value) {
      return null
    }

    // Get body from value
    let body = (value.body || value) as MarkdownNode
    if (this.excerpt && value.excerpt) {
      body = value.excerpt
    }
    const meta: ParsedContentMeta = {
      ...(value as ParsedContentMeta),
      tags: {
        ...tags,
        ...value?.tags || {}
      }
    }

    let component: string | ConcreteComponent = meta.component || tag
    if (typeof meta.component === 'object') {
      component = meta.component.name
    }

    // Resolve component if it's a Vue component
    component = resolveVueComponent(component as string)

    // Process children
    const children = (body.children || []).map(child => renderNode(child, h, meta))

    // Return Vue component
    return h(
        component as any,
        {
          ...contentProps,
          ...meta.component?.props,
          ...this.$attrs
        },
        {
          default: createSlotFunction(children)
        }
    )
  }
})

/**
 * Render a markdown node
 */
function renderNode (node: MarkdownNode, h: CreateElement, documentMeta: ParsedContentMeta, parentScope: any = {}): ContentVNode {
  /**
   * Render Text node
   */
  if (node.type === 'text') {
    return h(Text, node.value)
  }

  const originalTag = node.tag!
  // `_ignoreMap` is an special prop to disables tag-mapper
  const renderTag: string = (typeof node.props?.__ignoreMap === 'undefined' && documentMeta.tags[originalTag]) || originalTag

  if (node.tag === 'binding') {
    return renderBinding(node, h, documentMeta, parentScope)
  }

  const component = resolveVueComponent(renderTag)
  if (typeof component === 'object') {
    component.tag = originalTag
  }

  const props = propsToData(node, documentMeta)
  return h(
    component as any,
    props,
    renderSlots(node, h, documentMeta, { ...parentScope, ...props })
  )
}

function renderBinding (node: MarkdownNode, h: CreateElement, documentMeta: ParsedContentMeta, parentScope: any = {}): ContentVNode {
  const data = {
    ...parentScope,
    $route: () => useRoute(),
    $document: documentMeta,
    $doc: documentMeta
  }
  const splitter = /\.|\[(\d+)\]/
  const keys = node.props?.value.trim().split(splitter).filter(Boolean)
  const value = keys.reduce((data, key) => {
    if (key in data) {
      if (typeof data[key] === 'function') {
        return data[key]()
      } else {
        return data[key]
      }
    }
    return {}
  }, data)

  return h(Text, value)
}

/**
 * Create slots from `node` template children.
 */
function renderSlots (node: MarkdownNode, h: CreateElement, documentMeta: ParsedContentMeta, parentProps: any): ContentVNode[] {
  const children: MarkdownNode[] = node.children || []

  const slots: Record<string, Array<VNode | string>> = children.reduce((data, node) => {
    if (!isTemplate(node)) {
      data[DEFAULT_SLOT].push(renderNode(node, h, documentMeta, parentProps))
      return data
    }

    if (isDefaultTemplate(node)) {
      data[DEFAULT_SLOT].push(...(node.children || []).map(child => renderNode(child, h, documentMeta, parentProps)))
      return data
    }

    const slotName = getSlotName(node)
    data[slotName] = (node.children || []).map(child => renderNode(child, h, documentMeta, parentProps))

    return data
  }, {
    [DEFAULT_SLOT]: [] as any[]
  })

  const slotEntries = Object.entries(slots).map(([name, vDom]) => ([name, createSlotFunction(vDom)]))

  return Object.fromEntries(slotEntries)
}

/**
 * Create component data from node props.
 */
function propsToData (node: MarkdownNode, documentMeta: ParsedContentMeta) {
  const { tag = '', props = {} } = node
  return Object.keys(props).reduce(function (data, key) {
    // Ignore internal `__ignoreMap` prop.
    if (key === '__ignoreMap') { return data }

    const value = props[key]

    // `v-model="foo"`
    if (rxModel.test(key) && !nativeInputs.includes(tag)) {
      return propsToDataRxModel(key, value, data, documentMeta)
    }

    // `v-bind="{foo: 'bar'}"`
    if (key === 'v-bind') {
      return propsToDataVBind(key, value, data, documentMeta)
    }

    // `v-on="foo"`
    if (rxOn.test(key)) {
      return propsToDataRxOn(key, value, data, documentMeta)
    }

    // `:foo="bar"`, `v-bind:foo="bar"`
    if (rxBind.test(key)) {
      return propsToDataRxBind(key, value, data, documentMeta)
    }

    const { attribute } = find(html, key)

    // Join string arrays using space, see: https://github.com/nuxt/content/issues/247
    if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
      data[attribute] = value.join(' ')
      return data
    }

    data[attribute] = value

    return data
  }, {} as any)
}

/**
 * Handle `v-model`
 */
function propsToDataRxModel (key: string, value: any, data: any, documentMeta: ParsedContentMeta) {
  // Model modifiers
  const number = (d: any) => +d
  const trim = (d: any) => d.trim()
  const noop = (d: any) => d

  const mods = key
    .replace(rxModel, '')
    .split('.')
    .filter(d => d)
    .reduce((d, k) => {
      d[k] = true
      return d
    }, {} as any)

  // As of yet we don't resolve custom v-model field/event names from components
  const field = 'value'
  const event = mods.lazy ? 'change' : 'input'
  const processor = mods.number ? number : mods.trim ? trim : noop
  data[field] = evalInContext(value, documentMeta)
  data.on = data.on || {}
  data.on[event] = (e: any) => ((documentMeta as any)[value] = processor(e))

  return data
}

/**
 * Handle object binding `v-bind`
 */
function propsToDataVBind (_key: string, value: any, data: any, documentMeta: ParsedContentMeta) {
  const val = evalInContext(value, documentMeta)
  data = Object.assign(data, val)
  return data
}

/**
 * Handle `v-on` and `@`
 */
function propsToDataRxOn (key: string, value: any, data: any, documentMeta: ParsedContentMeta) {
  key = key.replace(rxOn, '')
  data.on = data.on || {}
  data.on[key] = () => evalInContext(value, documentMeta)
  return data
}

/**
 * Handle single binding `v-bind:` and `:`
 */
function propsToDataRxBind (key: string, value: any, data: any, documentMeta: ParsedContentMeta) {
  key = key.replace(rxBind, '')
  data[key] = evalInContext(value, documentMeta)
  return data
}

/**
 * Resolve component if it's a Vue component
 */
const resolveVueComponent = (component: string) => {
  // Check if node is not a native HTML tag
  if (!htmlTags.includes(component as any)) {
    const componentFn = resolveComponent(pascalCase(component), false)
    // If component exists
    if (typeof componentFn === 'object') {
      return componentFn
    }
  }
  return component
}

/**
 * Evaluate value in specific context
 */
function evalInContext (code: string, context: any) {
  // Retrive value from context
  const result = code
    .split('.')
    .reduce((o: any, k) => typeof o === 'object' ? o[k] : undefined, context)

  return typeof result === 'undefined' ? destr(code) : result
}

/**
 * Get slot name out of a node
 */
function getSlotName (node: MarkdownNode) {
  let name = ''
  for (const propName of Object.keys(node.props || {})) {
    // Check if prop name correspond to a slot
    if (!propName.startsWith('#') && !propName.startsWith('v-slot:')) {
      continue
    }
    // Get slot name
    name = propName.split(/[:#]/, 2)[1]
    break
  }
  return name || DEFAULT_SLOT
}

/**
 * Create a factory function if there is a node in the list
 */
function createSlotFunction (nodes: Array<VNode | string>) {
  return (nodes.length ? () => nodes : undefined)
}

/**
 * Check if node is root
 */
function isDefaultTemplate (node: MarkdownNode) {
  return isTemplate(node) && getSlotName(node) === DEFAULT_SLOT
}

/**
 * Check if node is Vue template tag
 */
function isTemplate (node: MarkdownNode) {
  return node.tag === 'template'
}

import { Serializer } from '@toolcase/base'

const serializer = new Serializer('test')

serializer.define('payload', [
    { key: 'username', type: 'string', rule: 'required' }
])

serializer.define('message', [
    { key: 'payload', type: 'payload', rule: 'repeated' }
])

serializer.define('server_message', [
    { key: 'topic', type: 'string', rule: 'required' },
    { key: 'payload', type: 'bytes', rule: 'required' }
])

export default serializer
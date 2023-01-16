import { Serializer } from '@toolcase/base'

const serializer = new Serializer('test')

serializer.define('payload', [
    { key: 'username', type: 'string', rule: 'required' }
])

serializer.define('message', [
    { key: 'payload', type: 'payload', rule: 'repeated' }
])

export default serializer
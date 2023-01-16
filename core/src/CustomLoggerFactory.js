import { ConsoleLogReporter, Level, LoggerFactory } from '@toolcase/logging'

class CustomLoggerFactory extends LoggerFactory {
    constructor() {
        super([
            new ConsoleLogReporter()
        ])
    }
}

CustomLoggerFactory.Instance = new CustomLoggerFactory()

export default CustomLoggerFactory
// echarts 按需注册：全量引入约 1MB，注册项目实际用到的图型与组件后显著减小 bundle。
// 新增图表类型时在此追加注册即可。
import * as echartsCore from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echartsCore.use([BarChart, LineChart, GridComponent, TooltipComponent, CanvasRenderer])

// echarts/core 运行时包含 init/graphic 等完整 API，但类型声明不含，断言为完整 echarts 类型
const echarts = echartsCore as unknown as typeof import('echarts')

export default echarts

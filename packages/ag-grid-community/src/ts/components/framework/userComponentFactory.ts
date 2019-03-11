import { Autowired, Bean, Context, Optional } from "../../context/context";
import { GridOptions } from "../../entities/gridOptions";
import { GridOptionsWrapper } from "../../gridOptionsWrapper";
import { FrameworkComponentWrapper } from "./frameworkComponentWrapper";
import { IComponent } from "../../interfaces/iComponent";
import { ColDef, ColGroupDef } from "../../entities/colDef";
import {
    AgGridComponentFunctionInput,
    AgGridRegisteredComponentInput,
    UserComponentRegistry,
    RegisteredComponent,
    RegisteredComponentSource
} from "./userComponentRegistry";
import { AgComponentUtils } from "./agComponentUtils";
import { ComponentMetadata, ComponentMetadataProvider } from "./componentMetadataProvider";
import { ISetFilterParams } from "../../interfaces/iSetFilterParams";
import { IRichCellEditorParams } from "../../interfaces/iRichCellEditorParams";
import { RowNode } from "../../entities/rowNode";
import { Column } from "../../entities/column";
import { GridApi } from "../../gridApi";
import { ColumnApi } from "../../columnController/columnApi";
import { ToolPanelDef } from "../../entities/sideBar";
import { _, Promise } from "../../utils";

export type DefinitionObject =
    GridOptions
    | ColDef
    | ColGroupDef
    | ISetFilterParams
    | IRichCellEditorParams
    | ToolPanelDef;

export type AgComponentPropertyInput<A extends IComponent<any>> = AgGridRegisteredComponentInput<A> | string | boolean;

export enum ComponentType {
    PLAIN_JAVASCRIPT, FRAMEWORK
}

export enum ComponentSource {
    DEFAULT, REGISTERED_BY_NAME, HARDCODED
}

export interface ComponentSelectorResult {
    component?: string;
    params?: any;
}

/**
 * B the business interface (ie IHeader)
 * A the agGridComponent interface (ie IHeaderComp). The final object acceptable by ag-grid
 */
export interface ComponentClassDef<A extends IComponent<any> & B, B> {
    component: { new(): A } | { new(): B };
    type: ComponentType; // [Plain Javascript, Framework]
    source: ComponentSource; // [Default, Registered by Name, Hard Coded]
    paramsFromSelector: any; // Params the selector function provided, if any
}

@Bean('userComponentFactory')
export class UserComponentFactory {

    @Autowired("gridOptions")
    private gridOptions: GridOptions;

    @Autowired("gridOptionsWrapper")
    private gridOptionsWrapper: GridOptionsWrapper;

    @Autowired("context")
    private context: Context;

    @Autowired("agComponentUtils")
    private agComponentUtils: AgComponentUtils;

    @Autowired("componentMetadataProvider")
    private componentMetadataProvider: ComponentMetadataProvider;

    @Autowired("userComponentRegistry")
    private userComponentRegistry: UserComponentRegistry;

    @Optional("frameworkComponentWrapper")
    private frameworkComponentWrapper: FrameworkComponentWrapper;

    /**
     * This method creates a component given everything needed to guess what sort of component needs to be instantiated
     * It takes
     *  @param definitionObject: This is the context for which this component needs to be created, it can be gridOptions
     *      (global) or columnDef mostly.
     *  @param paramsFromGrid: Params to be passed to the component and passed by ag-Grid. This will get merged with any params
     *      specified by the user in the configuration
     *  @param propertyName: The name of the property used in ag-grid as a convention to refer to the component, it can be:
     *      'floatingFilter', 'cellRenderer', is used to find if the user is specifying a custom component
     *  @param defaultComponentName: The actual name of the component to instantiate, this is usually the same as propertyName, but in
     *      some cases is not, like floatingFilter, if it is the same is not necessary to specify
     *  @param mandatory: Handy method to tell if this should return a component ALWAYS. if that is the case, but there is no
     *      component found, it throws an error, by default all components are MANDATORY
     *  @param customInitParamsCb: A chance to customise the params passed to the init method. It receives what the current
     *  params are and the component that init is about to get called for
     */
    public createUserComponent<A extends IComponent<any>>(definitionObject: DefinitionObject,
                                                          paramsFromGrid: any,
                                                          propertyName: string,
                                                          defaultComponentName?: string,
                                                          mandatory: boolean = true,
                                                          customInitParamsCb?: (params: any, component: A) => any): Promise<A> {

        if (!definitionObject) {
            definitionObject = this.gridOptions;
        }

        // Create the component instance
        const componentAndParams: {componentInstance: A, paramsFromSelector: any} = this.createComponentInstance(definitionObject, propertyName, paramsFromGrid, defaultComponentName, mandatory);
        if (!componentAndParams) { return null; }
        const componentInstance = componentAndParams.componentInstance;

        // Wire the component and call the init method with the correct params
        const finalParams = this.createFinalParams(definitionObject, propertyName, paramsFromGrid, componentAndParams.paramsFromSelector);

        // a temporary fix for AG-1574
        // AG-1715 raised to do a wider ranging refactor to improve this
        finalParams.agGridReact = this.context.getBean('agGridReact') ? _.cloneObject(this.context.getBean('agGridReact')) : {};
        // AG-1716 - directly related to AG-1574 and AG-1715
        finalParams.frameworkComponentWrapper = this.context.getBean('frameworkComponentWrapper') ? this.context.getBean('frameworkComponentWrapper') : {};

        const deferredInit: void | Promise<void> = this.initialiseComponent(componentInstance, finalParams, customInitParamsCb);
        if (deferredInit == null) {
            return Promise.resolve(componentInstance);
        } else {
            const asPromise: Promise<void> = deferredInit as Promise<void>;
            return asPromise.map(notRelevant => componentInstance);
        }
    }

    /**
     * This method creates a component given everything needed to guess what sort of component needs to be instantiated
     * It takes
     *  @param clazz: The class to instantiate,
     *  @param agGridParams: Params to be passed to the component and passed by ag-Grid. This will get merged with any params
     *      specified by the user in the configuration
     *  @param customInitParamsCb: A chance to customise the params passed to the init method. It receives what the current
     *  params are and the component that init is about to get called for
     */
    public createUserComponentFromConcreteClass<P, A extends IComponent<P>>(clazz: { new(): A },
                                                                            agGridParams: P,
                                                                            customInitParamsCb?: (params: any, component: A) => any): A {
        const internalComponent: A = new clazz() as A;

        this.initialiseComponent(
            internalComponent,
            agGridParams,
            customInitParamsCb
        );

        return internalComponent;
    }

    /**
     * This method returns the underlying representation of the component to be created. ie for Javascript the
     * underlying function where we should be calling new into. In case of the frameworks, the framework class
     * object that represents the component to be created.
     *
     * This method is handy for different reasons, for example if you want to check if a component has a particular
     * method implemented without having to create the component, just by inspecting the source component
     *
     * It takes
     *  @param definitionObject: This is the context for which this component needs to be created, it can be gridOptions
     *      (global) or columnDef mostly.
     *  @param propertyName: The name of the property used in ag-grid as a convention to refer to the component, it can be:
     *      'floatingFilter', 'cellRenderer', is used to find if the user is specifying a custom component
     *  @param params: Params to be passed to the dynamic component function in case it needs to be
     *      invoked
     *  @param defaultComponentName: The name of the component to load if there is no component specified
     */
    public getComponentClassDef<A extends IComponent<any> & B, B>(
        definitionObject: DefinitionObject,
        propertyName: string,
        params: any = null,
        defaultComponentName?: string
    ): ComponentClassDef<A, B> {
        /**
         * There are five things that can happen when resolving a component.
         *  a) HardcodedFwComponent: That holder[propertyName]Framework has associated a Framework native component
         *  b) HardcodedJsComponent: That holder[propertyName] has associate a JS component
         *  c) hardcodedJsFunction: That holder[propertyName] has associate a JS function
         *  d) hardcodedNameComponent: That holder[propertyName] has associate a string that represents a component to load
         *  e) That none of the three previous are specified, then we need to use the DefaultRegisteredComponent
         */
        let hardcodedNameComponent: string = null;
        let HardcodedJsComponent: { new(): A } = null;
        let hardcodedJsFunction: AgGridComponentFunctionInput = null;
        let HardcodedFwComponent: { new(): B } = null;
        let componentSelectorFunc: (params: any) => ComponentSelectorResult;

        if (definitionObject != null) {
            const componentPropertyValue: AgComponentPropertyInput<IComponent<any>> = (definitionObject as any)[propertyName];
            // for filters only, we allow 'true' for the component, which means default filter to be used
            const usingDefaultComponent = componentPropertyValue === true;
            if (componentPropertyValue != null && !usingDefaultComponent) {
                if (typeof componentPropertyValue === 'string') {
                    hardcodedNameComponent = componentPropertyValue;
                } else if (typeof componentPropertyValue === 'boolean') {
                    // never happens, as we test for usingDefaultComponent above,
                    // however it's needed for the next block to compile
                } else if (this.agComponentUtils.doesImplementIComponent(componentPropertyValue)) {
                    HardcodedJsComponent = componentPropertyValue as { new(): A };
                } else {
                    hardcodedJsFunction = componentPropertyValue as AgGridComponentFunctionInput;
                }
            }
            HardcodedFwComponent = (definitionObject as any)[propertyName + "Framework"];
            componentSelectorFunc = (definitionObject as any)[propertyName + "Selector"];
        }

        /**
         * Since we allow many types of flavors for specifying the components, let's make sure this is not an illegal
         * combination
         */

        if (
            (HardcodedJsComponent && HardcodedFwComponent) ||
            (hardcodedNameComponent && HardcodedFwComponent) ||
            (hardcodedJsFunction && HardcodedFwComponent)
        ) {
            throw Error("ag-grid: you are trying to specify: " + propertyName + " twice as a component.");
        }

        if (HardcodedFwComponent && !this.frameworkComponentWrapper) {
            throw Error("ag-grid: you are specifying a framework component but you are not using a framework version of ag-grid for : " + propertyName);
        }

        if (componentSelectorFunc && (hardcodedNameComponent || HardcodedJsComponent || hardcodedJsFunction || HardcodedFwComponent)) {
            throw Error("ag-grid: you can't specify both, the selector and the component of ag-grid for : " + propertyName);
        }

        /**
         * At this stage we are guaranteed to either have,
         * DEPRECATED
         * - A unique HardcodedFwComponent
         * - A unique HardcodedJsComponent
         * - A unique hardcodedJsFunction
         * BY NAME- FAVOURED APPROACH
         * - A unique hardcodedNameComponent
         * - None of the previous, hence we revert to: RegisteredComponent
         */
        if (HardcodedFwComponent) {
            // console.warn(`ag-grid: Since version 12.1.0 specifying a component directly is deprecated, you should register the component by name`);
            // console.warn(`${HardcodedFwComponent}`);
            return {
                type: ComponentType.FRAMEWORK,
                component: HardcodedFwComponent,
                source: ComponentSource.HARDCODED,
                paramsFromSelector: null
            };
        }

        if (HardcodedJsComponent) {
            // console.warn(`ag-grid: Since version 12.1.0 specifying a component directly is deprecated, you should register the component by name`);
            // console.warn(`${HardcodedJsComponent}`);
            return {
                type: ComponentType.PLAIN_JAVASCRIPT,
                component: HardcodedJsComponent,
                source: ComponentSource.HARDCODED,
                paramsFromSelector: null
            };
        }

        if (hardcodedJsFunction) {
            // console.warn(`ag-grid: Since version 12.1.0 specifying a function directly is deprecated, you should register the component by name`);
            // console.warn(`${hardcodedJsFunction}`);
            return this.agComponentUtils.adaptFunction(propertyName, hardcodedJsFunction, ComponentType.PLAIN_JAVASCRIPT, ComponentSource.HARDCODED) as ComponentClassDef<A, B>;
        }

        const selectorResult = componentSelectorFunc ? componentSelectorFunc(params) : null;

        let componentNameToUse: string;
        if (selectorResult && selectorResult.component) {
            componentNameToUse = selectorResult.component;
        } else if (hardcodedNameComponent) {
            componentNameToUse = hardcodedNameComponent;
        } else {
            componentNameToUse = defaultComponentName;
        }

        if (!componentNameToUse) { return null; }

        const registeredCompClassDef = this.lookupFromRegisteredComponents(propertyName, componentNameToUse) as ComponentClassDef<A, B>;

        return {
            type: registeredCompClassDef.type,
            component: registeredCompClassDef.component,
            source: registeredCompClassDef.source,
            paramsFromSelector: selectorResult ? selectorResult.params : null
        };
    }

    private lookupFromRegisteredComponents<A extends IComponent<any> & B, B>(propertyName: string,
                                                            componentNameOpt?: string): ComponentClassDef<A, B> {
        const componentName: string = componentNameOpt != null ? componentNameOpt : propertyName;

        const registeredComponent: RegisteredComponent<A, B> = this.userComponentRegistry.retrieve(componentName);
        if (registeredComponent == null) { return null; }

        //If it is a FW it has to be registered as a component
        if (registeredComponent.type == ComponentType.FRAMEWORK) {
            return {
                component: registeredComponent.component as { new(): B },
                type: ComponentType.FRAMEWORK,
                source: ComponentSource.REGISTERED_BY_NAME,
                paramsFromSelector: null
            };
        }

        //If it is JS it may be a function or a component
        if (this.agComponentUtils.doesImplementIComponent(registeredComponent.component as AgGridRegisteredComponentInput<A>)) {
            return {
                component: registeredComponent.component as { new(): A },
                type: ComponentType.PLAIN_JAVASCRIPT,
                source: (registeredComponent.source == RegisteredComponentSource.REGISTERED) ? ComponentSource.REGISTERED_BY_NAME : ComponentSource.DEFAULT,
                paramsFromSelector: null
            };
        }

        // This is a function
        return this.agComponentUtils.adaptFunction(
            propertyName,
            registeredComponent.component as AgGridComponentFunctionInput,
            registeredComponent.type,
            (registeredComponent.source == RegisteredComponentSource.REGISTERED) ? ComponentSource.REGISTERED_BY_NAME : ComponentSource.DEFAULT
        );
    }

    /**
     * Useful to check what would be the resultant params for a given object
     *  @param definitionObject: This is the context for which this component needs to be created, it can be gridOptions
     *      (global) or columnDef mostly.
     *  @param propertyName: The name of the property used in ag-grid as a convention to refer to the component, it can be:
     *      'floatingFilter', 'cellRenderer', is used to find if the user is specifying a custom component
     *  @param paramsFromGrid: Params to be passed to the component and passed by ag-Grid. This will get merged with any params
     *      specified by the user in the configuration
     * @returns {any} It merges the user agGridParams with the actual params specified by the user.
     */
    public createFinalParams(definitionObject: DefinitionObject,
                       propertyName: string,
                       paramsFromGrid: any,
                       paramsFromSelector: any = null): any {

        const res: any = {};
        _.mergeDeep(res, paramsFromGrid);

        const userParams: any = definitionObject ? (definitionObject as any)[propertyName + "Params"] : null;

        if (userParams != null) {
            if (typeof userParams === 'function') {
                _.mergeDeep(res, userParams(paramsFromGrid));
            } else if (typeof userParams === 'object') {
                _.mergeDeep(res, userParams);
            }
        }

        _.mergeDeep(res, paramsFromSelector);

        if (!res.api) {
            res.api = this.gridOptions.api;
        }

        return res;
    }

    private createComponentInstance<A extends IComponent<any> & B, B>(holder: DefinitionObject,
        propertyName: string,
        paramsForSelector: any,
        defaultComponentName?: string,
        mandatory: boolean = true
    ): {componentInstance: A, paramsFromSelector: any} {
        const componentToUse: ComponentClassDef<A, B> = this.getComponentClassDef(holder, propertyName, paramsForSelector, defaultComponentName) as ComponentClassDef<A, B>;

        const missing = !componentToUse || !componentToUse.component;
        if (missing) {
            if (mandatory) { console.error(`Error creating component ${propertyName}=>${defaultComponentName}`); }
            return null;
        }

        let componentInstance: A;

        if (componentToUse.type === ComponentType.PLAIN_JAVASCRIPT) {
            // Using plain JavaScript component
            componentInstance = new componentToUse.component() as A;
        } else {
            // Using framework component
            const FrameworkComponentRaw: { new(): B } = componentToUse.component;
            const thisComponentConfig: ComponentMetadata = this.componentMetadataProvider.retrieve(propertyName);
            componentInstance = this.frameworkComponentWrapper.wrap(FrameworkComponentRaw,
                thisComponentConfig.mandatoryMethodList,
                thisComponentConfig.optionalMethodList,
                defaultComponentName) as A;
        }

        return {componentInstance: componentInstance, paramsFromSelector: componentToUse.paramsFromSelector};
    }

    private initialiseComponent<A extends IComponent<any>>(component: A,
                                                           agGridParams: any,
                                                           customInitParamsCb?: (params: any, component: A) => any): Promise<void> | void {
        this.context.wireBean(component);
        if (component.init == null) { return; }

        if (customInitParamsCb == null) {
            return component.init(agGridParams);
        } else {
            return component.init(customInitParamsCb(agGridParams, component));
        }
    }

}